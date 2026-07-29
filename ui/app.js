var $=function(id){return document.getElementById(id)};
 var t=$('t'),sel=$('v'),speak=$('speak'),dl=$('dl'),err=$('err'),count=$('count'),
  speed=$('speed'),speedVal=$('speedVal'),status=$('status'),statusText=$('statusText'),
  portIn=$('port'),hotkeyIn=$('hotkey'),portNote=$('portNote'),smsg=$('smsg'),smsgTimer=null,
  consent=$('consent'),analyticsBox=$('analytics');
 var MAX=2000,DEF_VOICE='af_heart',DEF_SPEED=1;
 var audio=null;

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
 function setReady(){status.classList.add('ready');statusText.textContent='Ready'}
 function fail(msg){err.textContent=msg;err.style.display='block'}
 function updateCount(){var n=t.value.length;count.textContent=n+' / '+MAX;count.classList.toggle('warn',n>MAX*.9)}

 fetch('/api/voices').then(function(r){return r.json()}).then(function(vs){
  var langs={'en-US':'American','en-GB':'British'},groups={},order=[];
  vs.forEach(function(v){if(!groups[v.lang]){groups[v.lang]=[];order.push(v.lang)}groups[v.lang].push(v)});
  sel.innerHTML=order.map(function(lang){
   return '<optgroup label="'+(langs[lang]||lang)+'">'+groups[lang].map(function(v){
    var short=v.label.replace(/\s*\((?:American|British),\s*(F|M)\)/,' \u00b7 $1');
    return '<option value="'+v.id+'">'+short+'</option>'}).join('')+'</optgroup>'}).join('');
  sel.value=localStorage.getItem('chirp.voice')||DEF_VOICE;
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
 function track(ev,params){if(analyticsOn&&window.gtag)gtag('event',ev,params)}

 fetch('/api/settings').then(function(r){return r.json()}).then(function(s){
  portIn.value=s.port;
  // Empty field = default in effect; the default shows as placeholder so the
  // box can actually be cleared and re-captured.
  if(s.hotkeyCustom)hotkeyIn.value=s.hotkey;
  else hotkeyIn.placeholder=s.hotkey+' (default)';
  analyticsBox.checked=!!s.telemetry;
  if(s.telemetry===null||s.telemetry===undefined)consent.hidden=false;
  if(s.telemetry)loadAnalytics();
 });
 function saveTelemetry(on){
  analyticsBox.checked=on;
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({telemetry:on})})
  .then(function(){if(on)loadAnalytics();else analyticsOn=false})
  .catch(function(e){flash(e.message,true)});
 }
 $('consentYes').addEventListener('click',function(){consent.hidden=true;saveTelemetry(true);track('consent',{granted:true})});
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

 speed.value=localStorage.getItem('chirp.speed')||DEF_SPEED;
 showSpeed();updateCount();

 sel.addEventListener('change',function(){localStorage.setItem('chirp.voice',sel.value)});
 speed.addEventListener('input',function(){showSpeed();localStorage.setItem('chirp.speed',speed.value)});
 t.addEventListener('input',function(){updateCount();session++;stopAudio();player.hidden=true;chunks=[];cur=-1});
 $('reset').addEventListener('click',function(){
  sel.value=DEF_VOICE;speed.value=DEF_SPEED;showSpeed();
  localStorage.removeItem('chirp.voice');localStorage.removeItem('chirp.speed');
  portIn.value='';hotkeyIn.value='';saveSettings();
 });

 // Player: the text is the album, each sentence a track. Chunks are
 // generated on demand (next one prefetched) and cached for the session.
 var RATES=[0.75,1,1.25,1.5,2],rateIdx=1;
 var chunks=[],urls={},promises={},cur=-1,playing=false,raf=0,session=0;
 var player=$('player'),track=$('track'),transcript=$('transcript'),playBtn=$('play'),rateBtn=$('rate'),
  playSvg=playBtn.querySelector('svg'),
  PLAY='<path d="M5 3v10l8-5z"/>',PAUSE='<path d="M4 3h3v10H4zM9 3h3v10H9z"/>';

 function splitText(s){
  var out=[],re=/[^.!?\n]+[.!?]*(?:\u201d|["')\]])*\s*|\n+/g,m;
  while((m=re.exec(s))){var c=m[0].replace(/\s+/g,' ').trim();if(c)out.push(c)}
  return out;
 }

 function fetchChunk(i){
  if(urls[i])return Promise.resolve(urls[i]);
  if(!promises[i]){
   promises[i]=fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:chunks[i],voice:sel.value,speed:+speed.value})})
   .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||('HTTP '+r.status))});return r.blob()})
   .then(function(b){urls[i]=URL.createObjectURL(b);return urls[i]});
  }
  return promises[i];
 }

 function paint(){
  var segs=track.children;
  for(var i=0;i<segs.length;i++){
   var f=0;
   if(i<cur)f=100;
   else if(i===cur&&audio&&audio.duration)f=Math.min(100,audio.currentTime/audio.duration*100);
   segs[i].firstChild.style.width=f+'%';
  }
  var spans=transcript.children;
  for(var j=0;j<spans.length;j++)spans[j].className=j<cur?'done':j===cur?'active':'';
 }

 function tick(){paint();raf=requestAnimationFrame(tick)}

 function setPlayIcon(){playSvg.innerHTML=playing?PAUSE:PLAY;playBtn.setAttribute('aria-label',playing?'Pause':'Play')}

 function stopAudio(){
  if(audio){audio.pause();audio=null}
  playing=false;cancelAnimationFrame(raf);setPlayIcon();
 }

 function playChunk(i){
  if(i<0||i>=chunks.length)return;
  var s=session;
  cur=i;
  if(audio){audio.pause();audio=null}
  playing=false;cancelAnimationFrame(raf);paint();
  playBtn.disabled=true;
  fetchChunk(i).then(function(u){
   if(s!==session||cur!==i)return;
   audio=new Audio(u);audio.playbackRate=RATES[rateIdx];
   audio.onended=function(){
    if(s!==session)return;
    if(cur<chunks.length-1)playChunk(cur+1);
    else{cur=chunks.length;stopAudio();paint()}
   };
   playBtn.disabled=false;playing=true;setPlayIcon();setReady();
   tick();
   audio.play().catch(function(){});
   var active=transcript.children[i];if(active)active.scrollIntoView({block:'nearest'});
   if(i+1<chunks.length)fetchChunk(i+1);
  }).catch(function(e){if(s===session){playBtn.disabled=false;fail(e.message)}});
 }

 playBtn.addEventListener('click',function(){
  if(!chunks.length)return;
  if(audio&&playing){audio.pause();playing=false;cancelAnimationFrame(raf);setPlayIcon()}
  else if(audio){playing=true;setPlayIcon();tick();audio.play().catch(function(){})}
  else playChunk(cur>=0&&cur<chunks.length?cur:0);
 });
 $('prev').addEventListener('click',function(){playChunk(cur>0?cur-1:0)});
 $('next').addEventListener('click',function(){playChunk(cur+1)});
 rateBtn.addEventListener('click',function(){
  rateIdx=(rateIdx+1)%RATES.length;rateBtn.textContent=fmtSpeed(RATES[rateIdx]);
  if(audio)audio.playbackRate=RATES[rateIdx];
 });

 speak.addEventListener('click',function(){
  err.style.display='none';
  var text=t.value.trim();
  if(!text)return fail('Type something first.');
  session++;stopAudio();
  chunks=splitText(text);
  track('speak',{chars:text.length,voice:sel.value,sentences:chunks.length});
  for(var u in urls)URL.revokeObjectURL(urls[u]);
  urls={};promises={};cur=-1;
  track.innerHTML='';transcript.innerHTML='';
  var total=chunks.reduce(function(a,c){return a+c.length},0)||1;
  chunks.forEach(function(c,i){
   var seg=document.createElement('div');seg.className='seg';seg.style.width=(c.length/total*100)+'%';
   seg.appendChild(document.createElement('i'));
   seg.addEventListener('click',function(){playChunk(i)});
   track.appendChild(seg);
   var span=document.createElement('span');span.textContent=c+' ';
   span.addEventListener('click',function(){playChunk(i)});
   transcript.appendChild(span);
  });
  player.hidden=false;
  speak.disabled=true;speak.textContent='Generating\u2026';dl.disabled=true;
  fetchChunk(0)
   .then(function(){speak.disabled=false;speak.textContent='Speak';dl.disabled=false;playChunk(0)})
   .catch(function(e){speak.disabled=false;speak.textContent='Speak';fail(e.message)});
 });
 dl.addEventListener('click',function(){
  var text=t.value.trim();if(!text)return;
  track('download',{chars:text.length});
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
