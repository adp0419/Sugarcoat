"""Safety and latency regressions; no provider traffic, fake transports where needed."""
import asyncio
import json
from pathlib import Path
import threading
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import asr, decide, guard, main, rewrite, speakq, voice
from backend.config import settings
from backend.errors import ApiError
from backend.models import ASRResult, GuardResult, Job, RewriteRequest, RewriteResult
from test_twinly_client import DONE, Fake, make

MEANING_CHANGES = [
    ('We will approve the proposal.', 'We will reject the proposal.'),
    ('Send the file.', 'Delete the file.'),
    ('We can meet if it rains.', 'We can meet unless it rains.'),
    ('We will send the report.', 'We would send the report.'),
    ("Alice will review Bob's proposal.", "Bob will review Alice's proposal."),
    ('The temperature is -5 degrees.', 'The temperature is 5 degrees.'),
    ('We will pay $50.', 'We will pay €50.'),
    ('Do you know the answer?', 'Do the answer?'),
    ('I mean every word I said.', 'Every word I said.'),
    ('The team may release it.', 'The team must release it.'),
    ('Mina lends Owen the car.', 'Owen lends Mina the car.'),
    ('Keep the backup unless storage fails.', 'Keep the backup if storage fails.'),
]

@pytest.mark.parametrize('original,candidate', MEANING_CHANGES)
def test_substantive_edit_never_gets_offline_approval(monkeypatch, original, candidate):
    async def offline(*args):
        return decide.Verification(False)
    monkeypatch.setattr(decide, 'verify', offline)
    assert not asyncio.run(guard.check(original, candidate)).pass_

@pytest.mark.parametrize('text', ['Do you know the answer?', 'I mean every word I said.'])
def test_fallback_preserves_lexical_fillers(text):
    assert rewrite.minimal(text).rewrite == text

@pytest.mark.parametrize('candidate', ['We would send the report.', 'We will delete the report.', 'The report will send we.'])
def test_ai_edit_budget_rejects_new_words_or_order(candidate):
    assert rewrite.sanity('We will send the report.', RewriteResult(rewrite=candidate), 'presenter')


def test_surface_cleanup_skips_verifier_but_keeps_punctuation(monkeypatch):
    async def forbidden(*args):
        raise AssertionError('unnecessary verifier')
    monkeypatch.setattr(decide, 'verify', forbidden)
    assert asyncio.run(guard.check('We um will send it.', 'We will send it.')).pass_
    assert not rewrite.surface_equivalent("Let's eat, Grandma!", "Let's eat Grandma!")
    text = 'I want to I want to I want to speak.'
    assert asyncio.run(guard.check(text, text)).pass_

@pytest.mark.parametrize('path', ['/api/speak', '/api/speak/async'])
def test_speech_requires_exact_ready_revision_and_approval(approved_speech, path):
    body = approved_speech('We meet Monday.')
    with TestClient(main.app) as c:
        for delta in ({'job_id': 'missing'}, {'text': 'We meet Friday.'}, {'revision': 9}, {'approved': False}):
            assert c.post(path, json=body | delta).status_code in (404, 409)
        main.JOBS['j'].job.status = 'running'
        assert c.post(path, json=body).status_code == 409
        main.JOBS['j'].job.status = 'ready'
        main.JOBS['j'].job.guard = None
        assert c.post(path, json=body).status_code == 409
        assert c.post(path, json=body | {'override': True}).status_code in (200, 202)


def test_edit_takes_over_running_pipeline(monkeypatch):
    async def go():
        st = main.JobState(Job(id='takeover', verbatim='Original.', rewrite='Original.'))
        main.JOBS[st.job.id] = st
        entered = asyncio.Event()
        async def old_writer():
            entered.set()
            await asyncio.sleep(30)
            st.job.rewrite = 'Stale automated edit.'
        st.task = asyncio.create_task(old_writer())
        await entered.wait()
        result = await main.rewrite_endpoint(RewriteRequest(job_id='takeover', edited_text='Approved user edit.'))
        assert st.task.cancelled()
        assert result.rewrite == 'Approved user edit.' and result.revision == 1
    asyncio.run(go())


def test_mode_rerun_returns_immediately_and_invalidates_verdict(monkeypatch):
    async def go():
        st = main.JobState(Job(id='mode', status='ready', verbatim='Hello.', rewrite='Hello.',
                              guard=GuardResult(**{'pass': True})))
        main.JOBS['mode'] = st
        async def slow(*args):
            await asyncio.sleep(30)
        monkeypatch.setattr(main, 'run_ladder_watched', slow)
        response = await asyncio.wait_for(main.rewrite_endpoint(RewriteRequest(job_id='mode', mode='natural')), .1)
        assert response.status_code == 202 and st.job.guard is None and st.job.revision == 1
        st.task.cancel()
    asyncio.run(go())


def test_unknown_paid_outcome_survives_client_restart(tmp_path):
    fake = Fake(posts=[(503, {'error': {'code': 'job_unverified'}}), (200, DONE)])
    for _ in range(2):
        with pytest.raises(ApiError) as e:
            asyncio.run(make(tmp_path, fake).speak('Same line.'))
        assert e.value.code == 'job_unverified'
    assert fake.post_calls == 1


def test_poll_disconnect_reconciles_known_job_without_post(tmp_path):
    calls = []
    def handler(req):
        calls.append(req.method)
        if req.method == 'POST':
            return httpx.Response(202, json={'id': 'known', 'status': 'running'})
        if calls.count('GET') == 1:
            raise httpx.ReadError('disconnected')
        return httpx.Response(200, json=DONE)
    def client():
        return voice.TwinlyClient('key', 'https://fake/v1', tmp_path, transport=httpx.MockTransport(handler))
    with pytest.raises(ApiError):
        asyncio.run(client().speak('Line.'))
    assert asyncio.run(client().speak('Line.')).chunks
    assert calls == ['POST', 'GET', 'GET']


def test_later_chunks_not_submitted_after_failure(tmp_path):
    fake = Fake(posts=[(503, {'error': {'code': 'job_unverified'}})])
    text = 'First sentence. ' * 90
    with pytest.raises(ApiError):
        asyncio.run(make(tmp_path, fake).speak(text))
    assert fake.post_calls == 1


def test_separate_clients_same_account_are_serialized_and_deduped(tmp_path):
    async def go():
        state = {'active': 0, 'peak': 0, 'posts': 0}
        async def handler(req):
            state['active'] += 1
            state['posts'] += 1
            state['peak'] = max(state['peak'], state['active'])
            await asyncio.sleep(.03)
            state['active'] -= 1
            return httpx.Response(200, json=DONE)
        a = voice.TwinlyClient('key', 'https://fake/v1', tmp_path, transport=httpx.MockTransport(handler))
        b = voice.TwinlyClient('key', 'https://fake/v1', tmp_path, transport=httpx.MockTransport(handler))
        await asyncio.gather(a.speak('Same.'), b.speak('Same.'), b.speak('Different.'))
        assert state['peak'] == 1 and state['posts'] == 2
        await a.aclose(); await b.aclose()
    asyncio.run(go())


def test_async_queue_deduplicates_same_approved_request():
    async def go():
        from test_stage_mode import FakeVoice
        q, renderer = speakq.SpeakQueue(), FakeVoice()
        a = q.submit('job', 'Hello.', renderer)
        b = q.submit('job', 'Hello.', renderer)
        assert a.id == b.id
    asyncio.run(go())


def test_wav_conversion_and_bounded_window(tmp_path):
    src, dst = tmp_path/'source.wav', tmp_path/'converted.wav'
    with wave.open(str(src), 'wb') as f:
        f.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        f.writeframes(b'\x00\x00' * 16000 * 12)
    asyncio.run(asr.convert(src, dst, max_seconds=8, start_seconds=4))
    with wave.open(str(dst)) as f:
        assert f.getnframes() / f.getframerate() == 8
    asyncio.run(asr.convert(src, dst))
    with wave.open(str(dst)) as f:
        assert f.getnframes() / f.getframerate() == 12


def test_repeated_speech_is_not_discarded(monkeypatch, tmp_path):
    text = 'I want to I want to I want to say hello.'
    async def volume(*args):
        return -20
    monkeypatch.setattr(asr, 'mean_volume_db', volume)
    monkeypatch.setattr(asr, '_model', object())
    monkeypatch.setattr(asr, '_transcribe_sync', lambda *args: ASRResult(text=text))
    assert asyncio.run(asr.transcribe(tmp_path/'fake.wav')).text == text


def test_cancelled_waiter_does_not_release_actual_asr_occupancy(monkeypatch, tmp_path):
    async def go():
        entered, release = threading.Event(), threading.Event()
        async def volume(*args): return -20
        def transcribe(*args):
            entered.set(); release.wait(2)
            return ASRResult(text='Hello.')
        monkeypatch.setattr(asr, 'mean_volume_db', volume)
        monkeypatch.setattr(asr, '_model', object())
        monkeypatch.setattr(asr, '_transcribe_sync', transcribe)
        task = asyncio.create_task(asr.transcribe(tmp_path/'fake.wav'))
        try:
            while not entered.is_set(): await asyncio.sleep(.001)
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
            assert asr.busy()
            with pytest.raises(ApiError) as e: await asr.transcribe(tmp_path/'next.wav', word_timestamps=False)
            assert e.value.code == 'busy'
        finally:
            release.set()
            await asyncio.wrap_future(asr._inference)
    asyncio.run(go())


def test_light_mode_is_local_and_keeps_verbatim(monkeypatch):
    calls = []
    async def forbidden(*args, **kwargs):
        calls.append(1)
        raise AssertionError("Light mode must not call providers")
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(main, "_rewrite", forbidden)
    monkeypatch.setattr(decide, "verify", forbidden)
    text = "We um will meet Friday, no wait, Monday."
    st = main.JobState(Job(id="light", verbatim=text))
    asyncio.run(main.run_ladder(st, "minimal"))
    assert calls == []
    assert st.job.verbatim == text
    assert st.job.rewrite == "We will meet Friday, no wait, Monday."
    assert st.job.guard.pass_


def test_full_pipeline_deadline_includes_conversion(monkeypatch, tmp_path):
    async def stuck(*args):
        await asyncio.sleep(30)
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "JOB_DEADLINE_S", .03)
    monkeypatch.setattr(main, "_convert", stuck)
    src=tmp_path/"clip.wav"
    src.write_bytes(b"fake")
    st=main.JobState(Job(id="deadline"))
    asyncio.run(main.pipeline(st, src))
    assert st.job.status == "failed" and not src.exists()


def test_final_transcription_waits_for_active_live_pass(monkeypatch, tmp_path):
    async def go():
        async def volume(*args): return -20
        def transcribe(*args):
            import time
            time.sleep(.03)
            return ASRResult(text="Hello.")
        monkeypatch.setattr(asr, "mean_volume_db", volume)
        monkeypatch.setattr(asr, "_model", object())
        monkeypatch.setattr(asr, "_transcribe_sync", transcribe)
        live=asyncio.create_task(asr.transcribe(tmp_path/"live.wav", word_timestamps=False))
        await asyncio.sleep(.005)
        final=await asr.transcribe(tmp_path/"final.wav")
        assert final.text == "Hello." and (await live).text == "Hello."
    asyncio.run(go())


def test_recent_editor_failure_skips_stricter_retry_too(monkeypatch):
    from backend import status
    calls = []
    async def forbidden(*args, **kwargs):
        calls.append(1)
        raise AssertionError("Recent account failure must suppress every editor attempt")
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(status, "recent", lambda *args: "no_credits")
    monkeypatch.setattr(main, "_rewrite", forbidden)
    st=main.JobState(Job(id="circuit", verbatim="We um will go."))
    asyncio.run(main.run_ladder(st, "natural"))
    assert calls == []
    assert st.job.rewrite == "We will go." and st.job.guard.pass_


def test_surface_cleanup_preserves_acronyms_and_protected_terms():
    assert rewrite.surface_cleanup('He said "I um agree".') == 'He said "I um agree".'
    assert rewrite.surface_cleanup("UM and ER are labels.") == "UM and ER are labels."
    assert rewrite.surface_cleanup("Play um jam.", ["um jam"]) == "Play um jam."
    assert not rewrite.surface_equivalent("Play um jam.", "Play jam.", ["um jam"])
