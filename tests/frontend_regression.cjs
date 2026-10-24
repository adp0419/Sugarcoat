// Execute the actual no-build frontend in a small DOM harness. No network or media devices.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
  const nodes = new Map();
  function element() {
    return {value: '', checked: false, disabled: false, hidden: false, dataset: {}, style: {}, children: [],
      classList: {add(){}, remove(){}, toggle(){}}, listeners: {},
      addEventListener(type, fn) {this.listeners[type] = fn;},
      setAttribute(){}, getAttribute(){return null;}, removeAttribute(){}, append(...xs){this.children.push(...xs);}, replaceChildren(...xs){this.children = xs;},
      querySelector(){return element();}, querySelectorAll(){return [];}, scrollIntoView(){}, focus(){},
      pause(){this.paused = true;}, load(){}, play(){this.paused = false; this.plays = (this.plays || 0)+1; return Promise.resolve();},
      getContext(){return {clearRect(){}, fillRect(){}};}, getBoundingClientRect(){return {width: 100,height: 20};},
      dispatchEvent(e){this.listeners[e.type]?.(e);}};
  }
  const get = id => {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);};
  const context = vm.createContext({console, URLSearchParams, URL, AbortController, Blob, FormData,
    getComputedStyle: () => ({getPropertyValue: () => "#fff"}), location: {search: ''}, matchMedia: () => ({matches: true}), navigator: {}, window: {isSecureContext: true},
    localStorage: {getItem(){return null;}, setItem(){}},
    document: {body: element(), getElementById: get, querySelector: () => element(), querySelectorAll: () => [],
      createElement: element, createElementNS: element, addEventListener(){}},
    Audio: function(){return element();}, requestAnimationFrame: () => 0, cancelAnimationFrame(){},
    setTimeout: () => 1, clearTimeout(){}, setInterval: () => 1, clearInterval(){},
    fetch: () => new Promise(() => {}), performance, Event: function(type){this.type=type;},
  });
  vm.runInContext(fs.readFileSync('frontend/app.js','utf8') + '\n globalThis.h = {app, play, player, checkEdited, resetResult, syncSpeakButton, pollSpeak, showAudio, changeMode, stopPlayback, api};', context);
  // Presentation functions are irrelevant to race assertions; keep actual edit/approval/playback code.
  vm.runInContext('renderJob = () => {}; renderDiff = () => {}; setCheck = () => {};', context);
  context.setTimeout = (fn, ms) => {if (ms === 400) queueMicrotask(fn); return 1;};
  const h = context.h;
  h.app.job = {id: 'one', revision: 0, status: 'ready', rewrite: 'Monday.', guard: {pass: true}, mode_used: 'natural'};
  get('final-text').value = 'Monday.';
  return {h, get, context};
}
const deferred = () => {let resolve; const promise = new Promise(r=>resolve=r); return {promise, resolve};};
const response = body => ({ok:true, json:async()=>body});

test('typing immediately revokes old approval during debounce', () => {
  const {h,get} = harness();
  h.syncSpeakButton(); assert.equal(get('speak').disabled,false);
  get('final-text').value = 'Friday.'; get('final-text').listeners.input();
  assert.equal(h.app.job.guard,null); assert.equal(get('speak').disabled,true);
});

test('stale verifier cannot approve newer text or a new recording', async () => {
  for (const reset of [false,true]) {
    const {h,get,context} = harness(); const d = deferred(); context.fetch = () => d.promise;
    const pending = h.checkEdited();
    if (reset) { h.resetResult(); h.app.job = {id:'two', rewrite:'New.', guard:null}; get('final-text').value='New.'; }
    else { get('final-text').value='Friday.'; get('final-text').listeners.input(); }
    d.resolve(response({id:'one',revision:1,rewrite:'Monday.',guard:{pass:true}})); await pending;
    assert.equal(h.app.job.guard,null); assert.equal(h.app.job.id,reset?'two':'one');
  }
});

test('missing verdict is not approval', () => {
  const {h,get} = harness(); h.app.job.guard=null; h.syncSpeakButton();
  assert.equal(get('speak').disabled,true);
});

test('queued empty and partial chunks are not terminal', async () => {
  const {h,context} = harness();
  const states=[{status:'queued',chunks:[]},{status:'rendering',chunks:[{url:'a'}]},{status:'done',chunks:[{url:'a'},{url:'b'}]}];
  let calls=0; const seen=[];
  context.fetch=async()=>response(states[calls++]);
  const result=await h.pollSpeak('id',()=>true,r=>seen.push(r.status));
  assert.equal(calls,3); assert.equal(result.status,'done'); assert.deepEqual(seen,['queued','rendering','done']);
});

test('failed status with an empty array surfaces error', async () => {
  const {h,context}=harness(); context.fetch=async()=>response({status:'failed',chunks:[],error:{code:'job_unverified'}});
  await assert.rejects(h.pollSpeak('id'), e=>e.code==='job_unverified');
});

test('stale speech poll never publishes audio', async () => {
  const {h,context}=harness(); let current=true, published=0; const d=deferred(); context.fetch=()=>d.promise;
  const pending=h.pollSpeak('id',()=>current,()=>published++); current=false;
  d.resolve(response({status:'done',chunks:[{url:'old'}]})); await pending;
  assert.equal(published,0);
});

test('first chunk plays before completion, next arrives after underrun, no replay on poll', () => {
  const {h}=harness();
  const a={url:'a',seconds:2}, b={url:'b',seconds:3};
  h.showAudio({chunks:[a]},false,false);
  assert.equal(h.player.src,'a'); assert.equal(h.player.plays,1);
  h.player.onended(); assert.equal(h.play.waiting,true); assert.equal(h.play.done,false);
  h.showAudio({chunks:[a,b]},true,true);
  assert.equal(h.player.src,'b'); assert.equal(h.player.plays,2); assert.equal(h.play.total,5);
  h.showAudio({chunks:[a,b]},true,true); assert.equal(h.player.plays,2);
  h.player.onended(); assert.equal(h.play.done,true);
});

test('stale mode response cannot overwrite new recording', async () => {
  const {h,context}=harness(); const d=deferred(); context.fetch=()=>d.promise;
  const pending=h.changeMode('presenter'); h.resetResult(); h.app.job={id:'new',rewrite:'New.'};
  d.resolve(response({id:'one',status:'ready',rewrite:'Old.',mode_used:'presenter'})); await pending;
  assert.equal(h.app.job.id,'new'); assert.equal(h.app.job.rewrite,'New.');
});

test('API timeout remains active during response body read', async () => {
  const {h,context}=harness(); let expire;
  context.setTimeout=fn=>{expire=fn; return 1;}; context.clearTimeout=()=>{};
  context.fetch=async(_path,opts)=>({ok:true,json:()=>new Promise((_r,reject)=>{
    opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'})));
  })});
  const pending=h.api('/body'); await new Promise(setImmediate); expire();
  await assert.rejects(pending,e=>e.code==='timeout');
});
