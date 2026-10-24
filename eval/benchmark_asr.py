"""Local cached-weight benchmark only. Never calls paid APIs or downloads weights.
Run: HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv/bin/python eval/benchmark_asr.py
"""
import argparse
import asyncio
import json
from functools import partial
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import asr

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repeats', type=int, default=1)
    args = parser.parse_args()
    errors = []
    t = time.perf_counter()
    await asr.load()
    load_ms = (time.perf_counter() - t) * 1000
    rows = []
    loop = asyncio.get_running_loop()
    print('Model loaded; timing on the production inference worker', flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / 'clip.wav'
        await asr.convert(Path('frontend/demo-clip.m4a'), wav)
        # Interleave to reduce warmup/order bias. All paths request word timestamps.
        for repeat in range(args.repeats):
            for mode in ('verbatim', 'intended', 'dual'):
                t = time.perf_counter()
                if mode == 'dual':
                    try:
                        results = await loop.run_in_executor(asr._pool, partial(asr._model.transcribe_dual, str(wav), language='en', word_timestamps=True))
                    except NotImplementedError as error:
                        errors.append({'mode': mode, 'error': str(error)})
                        continue
                else:
                    results = [await loop.run_in_executor(asr._pool, partial(asr._model.transcribe, str(wav), mode=mode, language='en', word_timestamps=True))]
                row = {'repeat': repeat, 'mode': mode, 'ms': round((time.perf_counter()-t)*1000, 2),
                       'texts': [asr.clean_tags(r.text) for r in results]}
                rows.append(row)
                print(json.dumps(row), flush=True)
    output = {'kind': 'local real inference; one synthetic clip; no human WER reference',
              'load_warmup_ms': round(load_ms, 2), 'rows': rows, 'errors': errors,
              'median_ms': {m: statistics.median(r['ms'] for r in rows if r['mode'] == m)
                            for m in ('verbatim', 'intended', 'dual') if any(r['mode'] == m for r in rows)}}
    Path('eval/optimization_asr.json').write_text(json.dumps(output, indent=2)+'\n')

if __name__ == '__main__':
    asyncio.run(main())
