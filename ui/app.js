var $=function(id){return document.getElementById(id)};
 var t=$('t'),sel=$('v'),speak=$('speak'),dl=$('dl'),err=$('err'),count=$('count'),
  // NOT `status`: a top-level `var status` assigns to the legacy window.status
  // string property, which silently coerces the element to text.
  speed=$('speed'),speedVal=$('speedVal'),statusDot=$('status'),statusText=$('statusText'),
  portIn=$('port'),hotkeyIn=$('hotkey'),portNote=$('portNote'),smsg=$('smsg'),smsgTimer=null,
  consent=$('consent'),analyticsBox=$('analytics');
 var MAX=2000,DEF_VOICE='af_heart',DEF_SPEED=1;

 var navs=document.querySelectorAll('.nav');
 function showView(name){
  navs.forEach(function(b){b.classList.toggle('active',b.getAttribute('data-view')===name)});
  $('view-voice').hidden=name!=='voice';
  $('view-settings').hidden=name!=='settings';
  if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);
 }
 navs.forEach(function(b){b.addEventListener('click',function(){showView(b.getAttribute('data-view'))})});
 showView(location.hash==='#settings'?'settings':'voice');

 function fmtSpeed(n){n=Math.round(n*100)/100;return (n%1?n.toFixed(2).replace(/0$/,''):String(n))+'\u00d7'}
 function showSpeed(){speedVal.textContent=fmtSpeed(+speed.value)}
 function setReady(){statusDot.classList.add('ready');statusText.textContent='Ready'}
 function fail(msg){err.textContent=msg;err.style.display='block'}
 function updateCount(){var n=t.value.length;count.textContent=n+' / '+MAX;count.classList.toggle('warn',n>MAX*.9)}

 // All 28 voices, best-graded first, with the shortlist surfaced separately.
 // Values come from our own catalog, not user input.
 var voicesReady=fetch('/api/voices').then(function(r){return r.json()}).then(function(vs){
  var group=function(label,list){
   if(!list.length)return '';
   return '<optgroup label="'+label+'">'+list.map(function(v){
    return '<option value="'+v.id+'">'+v.name+' \u00b7 '+(v.lang==='en-gb'?'GB':'US')+' '+v.gender+
     ' \u00b7 '+v.grade+'</option>';
   }).join('')+'</optgroup>';
  };
  sel.innerHTML=group('Recommended',vs.filter(function(v){return v.recommended}))+
   group('All voices',vs.filter(function(v){return !v.recommended}));
  sel.value=DEF_VOICE;
 });
 fetch('/api/health').then(function(r){return r.json()}).then(function(h){if(h.modelLoaded)setReady()});

 function flash(msg,isErr){
  smsg.textContent=msg;smsg.classList.toggle('err',!!isErr);
  clearTimeout(smsgTimer);
  if(msg)smsgTimer=setTimeout(function(){smsg.textContent=''},4000);
 }
 // Analytics (opt-in): gtag loads only after consent, and events carry
 // counts and ids — never text. Offline, the script simply never arrives.
 var GA_ID='G-M72NFQRWXN',analyticsOn=false,gaLoaded=false;
 function loadAnalytics(){
  if(gaLoaded)return;gaLoaded=true;analyticsOn=true;
  var s=document.createElement('script');s.async=true;
  s.src='https://www.googletagmanager.com/gtag/js?id='+GA_ID;
  document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[];
  window.gtag=function(){dataLayer.push(arguments)};
  gtag('js',new Date());
  gtag('config',GA_ID);
 }
 // track_ , not track: `track` is the progress-bar element below.
 function track_(ev,params){if(analyticsOn&&window.gtag)gtag('event',ev,params)}

 fetch('/api/settings').then(function(r){return r.json()}).then(function(s){
  portIn.value=s.port;
  $('portLabel').textContent=s.activePort;
  // Empty field = default in effect; the default shows as placeholder so the
  // box can actually be cleared and re-captured.
  if(s.hotkeyCustom)hotkeyIn.value=s.hotkey;
  else hotkeyIn.placeholder=s.hotkey+' (default)';
  if(s.hotkeyOk===false)flash('That hotkey is in use by another app — pick another.',true);
  analyticsBox.checked=!!s.telemetry;
  if(s.telemetry===null||s.telemetry===undefined)consent.hidden=false;
  if(s.telemetry)loadAnalytics();
  // The config file is authoritative for voice and speed; apply the voice
  // only once the <select> has its options.
  speed.value=s.speed;showSpeed();rateBtn.textContent=fmtSpeed(s.speed);
  voicesReady.then(function(){if(s.voice)sel.value=s.voice});
 });
 function saveTelemetry(on){
  analyticsBox.checked=on;
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({telemetry:on})})
  .then(function(){if(on)loadAnalytics();else analyticsOn=false})
  .catch(function(e){flash(e.message,true)});
 }
 $('consentYes').addEventListener('click',function(){consent.hidden=true;saveTelemetry(true);track_('consent',{granted:true})});
 $('consentNo').addEventListener('click',function(){consent.hidden=true;saveTelemetry(false)});
 analyticsBox.addEventListener('change',function(){saveTelemetry(analyticsBox.checked)});
 function saveSettings(){
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({port:portIn.value.trim(),hotkey:hotkeyIn.value.trim()})})
  .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})})
  .then(function(s){
   portIn.value=s.port;
   if(!hotkeyIn.value)hotkeyIn.placeholder=s.hotkey+' (default)';
   portNote.textContent=s.restartRequired?'after restart':'';
   flash(s.restartRequired?'Saved — restart Chirp to use the new port.':'Saved.');
  })
  .catch(function(e){flash(e.message,true)});
 }
 portIn.addEventListener('change',saveSettings);
 // Press-to-set: capture the physical combo in accelerator form.
 // Backspace/Delete clears (back to default), Tab moves focus, Escape blurs.
 hotkeyIn.addEventListener('keydown',function(e){
  if(e.key==='Tab')return;
  e.preventDefault();
  if(['Meta','Control','Alt','Shift'].indexOf(e.key)>=0)return;
  if(e.key==='Escape'){hotkeyIn.blur();return}
  if(e.key==='Backspace'||e.key==='Delete'){hotkeyIn.value='';saveSettings();return}
  if(!(e.metaKey||e.ctrlKey||e.altKey))return flash('Add a modifier — Cmd, Ctrl, or Alt.',true);
  var parts=[];
  if(e.metaKey)parts.push('CmdOrCtrl');
  if(e.ctrlKey)parts.push('Ctrl');
  if(e.altKey)parts.push('Alt');
  if(e.shiftKey)parts.push('Shift');
  var k=e.key===' '?'Space':e.key.replace(/^Arrow/,'');
  parts.push(k.length===1?k.toUpperCase():k);
  hotkeyIn.value=parts.join('+');
  saveSettings();
 });
 hotkeyIn.addEventListener('change',saveSettings);
 // Test the hotkey's action: speak the clipboard (or the textarea) through
 // the same /api/speak path the global hotkey uses.
 $('hotkeyTest').addEventListener('click',function(){
  var speakSample=function(text){
   text=(text||'').trim()||'Chirp hotkey test.';
   flash('Speaking\u2026');
   fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})})
   .then(function(r){return r.json().then(function(d){
    if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
    flash('Played. Now press your combo anywhere to test the hotkey itself.');
   })})
   .catch(function(e){flash(e.message,true)});
  };
  if(navigator.clipboard&&navigator.clipboard.readText)navigator.clipboard.readText().then(speakSample,function(){speakSample(t.value)});
  else speakSample(t.value);
 });

 updateCount();

 // Voice and speed live in ~/.chirp/config.json now, so the hotkey and the
 // CLI use whatever is chosen here.
 sel.addEventListener('change',function(){
  post('/api/settings',{voice:sel.value}).catch(function(e){flash(e.message,true)});
 });
 speed.addEventListener('input',function(){showSpeed()});
 speed.addEventListener('change',function(){
  rateBtn.textContent=fmtSpeed(+speed.value);
  post('/api/settings',{speed:+speed.value}).catch(function(e){flash(e.message,true)});
 });
 t.addEventListener('input',function(){updateCount()});
 // Blank values remove the overrides, so every setting returns to its default.
 $('reset').addEventListener('click',function(){
  sel.value=DEF_VOICE;speed.value=DEF_SPEED;showSpeed();
  rateBtn.textContent=fmtSpeed(DEF_SPEED);
  portIn.value='';hotkeyIn.value='';
  post('/api/settings',{port:'',hotkey:'',voice:'',speed:''})
   .then(function(){portNote.textContent='';flash('Reset to defaults.')})
   .catch(function(e){flash(e.message,true)});
 });

 // The server owns playback; this is a remote control and a transcript view.
 // Position within the current sentence is interpolated locally from
 // startedAt/durationMs so the progress bar stays smooth without a chatty feed.
 var state={state:'idle',index:0,count:0,startedAt:0,durationMs:0},sentences=[],raf=0;
 var player=$('player'),track=$('track'),transcript=$('transcript'),playBtn=$('play'),rateBtn=$('rate'),
  playSvg=playBtn.querySelector('svg'),
  PLAY='<path d="M5 3v10l8-5z"/>',PAUSE='<path d="M4 3h3v10H4zM9 3h3v10H9z"/>';

 function renderTranscript(){
  track.innerHTML='';transcript.innerHTML='';
  var total=sentences.reduce(function(a,c){return a+c.length},0)||1;
  sentences.forEach(function(c,i){
   var seg=document.createElement('div');seg.className='seg';
   seg.style.width=(c.length/total*100)+'%';
   seg.appendChild(document.createElement('i'));
   seg.addEventListener('click',function(){seek(i)});
   track.appendChild(seg);
   var span=document.createElement('span');span.textContent=c+' ';
   span.addEventListener('click',function(){seek(i)});
   transcript.appendChild(span);
  });
  player.hidden=sentences.length===0;
 }

 function paint(){
  var segs=track.children;
  var frac=0;
  if(state.state==='speaking'&&state.durationMs)
   frac=Math.min(1,(Date.now()-state.startedAt)/state.durationMs);
  for(var i=0;i<segs.length;i++){
   var f=i<state.index?100:i===state.index?frac*100:0;
   segs[i].firstChild.style.width=f+'%';
  }
  var spans=transcript.children;
  for(var j=0;j<spans.length;j++)
   spans[j].className=j<state.index?'done':j===state.index?'active':'';
  playSvg.innerHTML=state.state==='speaking'?PAUSE:PLAY;
  playBtn.setAttribute('aria-label',state.state==='speaking'?'Pause':'Play');
 }

 function tick(){paint();raf=requestAnimationFrame(tick)}
 function startTicking(){if(!raf)tick()}
 function stopTicking(){cancelAnimationFrame(raf);raf=0;paint()}

 function post(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
   body:body?JSON.stringify(body):undefined})
   .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})});
 }

 // No per-sentence seek endpoint: step from where we are. Sessions are short
 // enough that this is instant, and it keeps the API to one concept.
 function seek(i){
  var steps=i-state.index,fn=steps<0?'prev':'next',n=Math.abs(steps);
  var chain=Promise.resolve();
  for(var k=0;k<n;k++)chain=chain.then(function(){return post('/api/playback/'+fn)});
  chain.catch(function(e){fail(e.message)});
 }

 var es=new EventSource('/api/playback/events');
 es.addEventListener('sentences',function(e){
  var d=JSON.parse(e.data);
  sentences=d.sentences||[];
  renderTranscript();
 });
 es.addEventListener('state',function(e){
  state=JSON.parse(e.data);
  if(state.count===0&&sentences.length){sentences=[];renderTranscript()}
  if(state.state==='speaking')startTicking();else stopTicking();
  // Paint on the event too, not only from rAF: requestAnimationFrame is
  // paused in a background tab, and the transcript must still be correct
  // when you switch back to it.
  paint();
  if(state.state!=='idle')setReady();
  var active=transcript.children[state.index];
  if(active&&state.state==='speaking')active.scrollIntoView({block:'nearest'});
 });
 // EventSource fires a native 'error' (with no .data) when the connection
 // drops, and the browser reconnects on its own. Only our server-sent frames
 // carry data, so parsing defensively keeps a reconnect from showing as a
 // speech failure.
 es.addEventListener('error',function(e){
  try{fail(JSON.parse(e.data).message)}catch(_){}
 });
 // Once loaded, stay loaded: transformers.js keeps emitting per-file progress
 // after the model resolves, which would otherwise overwrite "Ready".
 var modelReady=false;
 es.addEventListener('model',function(e){
  var m=JSON.parse(e.data);
  if(m.error)return fail(m.error);
  if(m.loaded){modelReady=true;return setReady()}
  if(modelReady)return;
  // Only speak up once something is actually happening — the feed also sends
  // {loaded:false} on connect, which just means "not loaded yet".
  if(m.progress!=null)statusText.textContent='Downloading model — '+Math.round(m.progress*100)+'%';
 });

 playBtn.addEventListener('click',function(){
  if(state.state==='speaking')post('/api/playback/pause').catch(function(e){fail(e.message)});
  else if(state.state==='paused')post('/api/playback/resume').catch(function(e){fail(e.message)});
  else speak.click();
 });
 $('prev').addEventListener('click',function(){post('/api/playback/prev').catch(function(e){fail(e.message)})});
 $('next').addEventListener('click',function(){post('/api/playback/next').catch(function(e){fail(e.message)})});

 // Rate now changes the generated speech, not just the playback rate of an
 // already-rendered clip, so it re-speaks the current sentence.
 var RATES=[0.75,1,1.25,1.5,2];
 rateBtn.addEventListener('click',function(){
  var i=(RATES.indexOf(+speed.value)+1)%RATES.length;
  speed.value=RATES[i];showSpeed();rateBtn.textContent=fmtSpeed(RATES[i]);
  post('/api/settings',{speed:RATES[i]}).catch(function(e){fail(e.message)});
 });

 speak.addEventListener('click',function(){
  err.style.display='none';
  var text=t.value.trim();
  if(!text)return fail('Type something first.');
  track_('speak',{chars:text.length,voice:sel.value});
  speak.disabled=true;speak.textContent='Generating…';
  post('/api/speak',{text:text,voice:sel.value,speed:+speed.value})
   .then(function(){speak.disabled=false;speak.textContent='Speak';dl.disabled=false})
   .catch(function(e){speak.disabled=false;speak.textContent='Speak';fail(e.message)});
 });
 dl.addEventListener('click',function(){
  var text=t.value.trim();if(!text)return;
  track_('download',{chars:text.length});
  dl.disabled=true;
  fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({text:text,voice:sel.value,speed:+speed.value})})
  .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||('HTTP '+r.status))});return r.blob()})
  .then(function(b){
   var u=URL.createObjectURL(b),a=document.createElement('a');
   a.href=u;a.download='chirp.wav';a.click();
   setTimeout(function(){URL.revokeObjectURL(u)},5000);dl.disabled=false;
  })
  .catch(function(e){dl.disabled=false;fail(e.message)});
 });
 document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();speak.click()}
 });
