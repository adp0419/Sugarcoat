"""Offline before/after harness; injectable delays are NOT live provider performance.
Example: .venv/bin/python eval/benchmark_optimization.py --repo /tmp/voiceflow-baseline --out eval/optimization_before.json
"""
import argparse
import asyncio
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', default='.')
parser.add_argument('--out', required=True)
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(args.repo).resolve()))
from backend import main, asr, decide, guard, speakq
from backend.config import settings
from backend.models import ASRResult, Decisions, GuardResult, Job, RewriteResult, AudioChunk

async def measure():
    settings.MOCK = False
    settings.KEEP_AUDIO = False
    # All providers replaced at their orchestration boundary. No keys or HTTP calls used.
    async def convert(*args): pass
    async def transcription(*args):
        await asyncio.sleep(.04)
        return ASRResult(text='We um will send the report.')
    async def analyze(*args):
        await asyncio.sleep(.08)
        return Decisions(recommended_mode='natural')
    async def edit(*args):
        await asyncio.sleep(.06)
        return RewriteResult(rewrite='We will send the report.'), 'fake'
    async def verify(*args):
        await asyncio.sleep(.04)
        return GuardResult(**{'pass': True, 'verifier': 'online'})
    main._convert, asr.transcribe, main._decide, main._rewrite, main._guard = convert, transcription, analyze, edit, verify
    elapsed=[]
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(11):
            st=main.JobState(Job(id=f'benchmark-{i}'))
            start=time.perf_counter()
            await main.pipeline(st, Path(tmp)/'clip.webm')
            assert st.job.status == 'ready'
            if i: elapsed.append(round((time.perf_counter()-start)*1000,3))
    class Renderer:
        def cached(self,text): return None
        async def render(self,text):
            await asyncio.sleep(.1)
            return AudioChunk(url='/fake',seconds=1)
    first=[]; complete=[]
    for i in range(10):
        q=speakq.SpeakQueue()
        task=q.submit('fake', ' '.join(f'Part {n} '+ 'word '*90+'.' for n in range(3)),Renderer())
        assert len(task.texts)==3
        start=time.perf_counter()
        while not task.chunks: await asyncio.sleep(.001)
        first.append(round((time.perf_counter()-start)*1000,3))
        while task.status!='done': await asyncio.sleep(.001)
        complete.append(round((time.perf_counter()-start)*1000,3))
        q._worker.cancel()
    async def offline(*args): return decide.Verification(False)
    decide.verify=offline
    cases=json.loads((ROOT/'eval/guard_cases.json').read_text())
    # Include the exact identity cases used by the established guard CLI.
    import importlib.util
    spec=importlib.util.spec_from_file_location('guard_eval',ROOT/'eval/guard_eval.py')
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    cases += module.identity_cases()
    cases += json.loads((ROOT/'eval/optimization_cases.json').read_text())
    rows=[]
    for c in cases:
        result=await guard.check(c['original'],c['rewrite'],protected=c.get('protected',()))
        rows.append({'id':c['id'],'expected':c['expect'],'approved':result.pass_,
                     'rules':[v.rule for v in result.violations]})
    good=[r for r in rows if r['expected']=='pass']; bad=[r for r in rows if r['expected']=='fail']
    ticks_before=list(range(3,45,3)); ticks_after=list(range(4,46,4))
    return {'repo':str(Path(args.repo).resolve()), 'kind':'controlled local delays + labelled offline safety cases',
            'provider_delays_ms': {'asr':40,'analysis':80,'rewrite':60,'independent_guard':40,'per_audio_chunk':100},
            'pipeline_ms':elapsed,'pipeline_median_ms':statistics.median(elapsed),
            'audio_first_ready_ms':first,'audio_all_ready_ms':complete,
            'first_ready_median_ms':statistics.median(first),'all_ready_median_ms':statistics.median(complete),
            'live_work_model':{'clip_seconds':45,'before_ticks':ticks_before,'after_ticks':ticks_after,
                'before_asr_seconds':sum(ticks_before),'after_asr_seconds':sum(min(8,t) for t in ticks_after),
                'note':'upper-bound submitted audio seconds, assuming each request completes before next tick; not measured compute speed'},
            'offline_safety':{'good':len(good),'bad':len(bad),'good_autoapproved':sum(r['approved'] for r in good),
                              'bad_autoapproved':sum(r['approved'] for r in bad),'rows':rows}}

if __name__=='__main__':
    output=asyncio.run(measure())
    Path(args.out).write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps({k:v for k,v in output.items() if k not in ('offline_safety','pipeline_ms','audio_first_ready_ms','audio_all_ready_ms')},indent=2))
    print({k:v for k,v in output['offline_safety'].items() if k!='rows'})
