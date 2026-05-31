import WebSocket from 'ws';
const PORT=8788, CID='qa-ws';
function ask(text, route='auto'){
  return new Promise((resolve)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${PORT}/?cid=${CID}`);
    let reply='', done=false;
    const t=setTimeout(()=>{if(!done){done=true;try{ws.close()}catch{};resolve('(timeout)')}},45000);
    ws.on('open',()=>ws.send(JSON.stringify({text,route,model:''})));
    ws.on('message',(d)=>{try{const m=JSON.parse(d.toString());if(m.type==='reply'){reply=m.text;done=true;clearTimeout(t);ws.close();resolve(reply);}}catch{}});
    ws.on('error',(e)=>{if(!done){done=true;clearTimeout(t);resolve('(ws error '+e.message+')')}});
  });
}
const tests=[
  ['profile','auto',"I'm Cristian and I prefer very concise answers."],
  ['convert-local','local','convert 12 miles to kilometers'],
  ['weather-local','local',"what's the weather in Toronto right now?"],
];
for(const [label,route,text] of tests){
  const r=await ask(text,route);
  console.log('\n### '+label+' ['+route+'] :: '+text+'\n-> '+String(r).replace(/\s+/g,' ').slice(0,260));
}
process.exit(0);
