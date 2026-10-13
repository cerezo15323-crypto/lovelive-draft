import http from 'node:http';
import {randomBytes, randomInt} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT)||3000;
const works={
 muse:{label:'μ’s',school:'国立音ノ木坂学院',names:['高坂穂乃果','絢瀬絵里','南ことり','園田海未','星空凛','西木野真姫','東條希','小泉花陽','矢澤にこ']},
 aqours:{label:'Aqours',school:'私立浦の星女学院',names:['高海千歌','桜内梨子','松浦果南','黒澤ダイヤ','渡辺曜','津島善子','国木田花丸','小原鞠莉','黒澤ルビィ']},
 niji:{label:'虹ヶ咲',school:'虹ヶ咲学園',names:['上原歩夢','中須かすみ','桜坂しずく','朝香果林','宮下愛','近江彼方','優木せつ菜','エマ・ヴェルデ','天王寺璃奈','三船栞子','ミア・テイラー','鐘嵐珠']},
 liella:{label:'Liella!',school:'結ヶ丘女子高等学校',names:['澁谷かのん','唐可可','嵐千砂都','平安名すみれ','葉月恋','桜小路きな子','米女メイ','若菜四季','鬼塚夏美','ウィーン・マルガレーテ','鬼塚冬毬']},
 hasu:{label:'蓮ノ空（104期）',school:'蓮ノ空女学院',names:['日野下花帆','村野さやか','乙宗梢','夕霧綴理','大沢瑠璃乃','藤島慈','百生吟子','徒町小鈴','安養寺姫芽']}
};
const all=Object.entries(works).flatMap(([group,w])=>w.names.map((name,i)=>({id:group+'-'+i,group,groupLabel:w.label,school:w.school,name})));
const rooms=new Map();
const id=()=>randomBytes(15).toString('hex');
const code=()=>randomBytes(4).toString('hex').toUpperCase();
function roster(r){return all.filter(x=>r.settings.groups.includes(x.group));}
function participants(r){return r.players.filter(p=>p.active!==false);}
function currentEligible(r){return r.stage==='auction'?r.auctionTeams:[];}
function publicRoom(r,token){let self=r.players.find(p=>p.token===token);return {code:r.code,settings:r.settings,players:r.players.map(p=>({id:p.id,name:p.name,picks:p.picks})),selfId:self?.id,host:self?.id===r.players[0]?.id,stage:r.stage,round:r.round,announcement:r.announcement,queue:r.queue,queueIndex:r.queueIndex,submitted:r.stage==='auction'?r.auctionTeams.filter(x=>r.submissions[x]).length:0,required:r.auctionTeams.length,submittedMine:!!r.submissions[self?.id],auctionTeams:r.auctionTeams,lottery:r.lottery?{candidate:r.lottery.candidate,teams:r.lottery.teams,drawIndex:r.lottery.drawIndex,draws:r.lottery.draws.map(x=>({team:x.team,envelope:x.envelope,opened:x.opened,win:x.opened?x.win:undefined})),revealed:r.lottery.revealed}:null,waiverTurn:r.waiverOrder?.[r.waiverIndex],history:r.history,candidates:roster(r).filter(c=>!r.taken.includes(c.id)),taken:r.taken};}
function push(r){for(const res of r.watchers){try{res.write(`data: ${JSON.stringify({time:Date.now()})}\n\n`);}catch{r.watchers.delete(res);}}}
function fail(msg,status=400){const e=new Error(msg);e.status=status;throw e;}
function assertHost(r,p){if(r.players[0]?.id!==p.id)fail('ホストだけが操作できるよ');}
function findPlayer(r,token){let p=r.players.find(x=>x.token===token);if(!p)fail('このルームの参加情報がないよ',403);return p;}
function stillEligible(r,p){if(!r.auctionTeams.includes(p.id))fail('今回の入札対象外だよ');}
function startAuction(r,teamIds){r.stage='auction';r.auctionTeams=teamIds;r.submissions={};r.queue=[];r.queueIndex=0;r.announcement=null;r.lottery=null;}
function startWaiver(r){r.round=2;r.stage='waiver';r.waiverIndex=0;setWaiverOrder(r);}
function setWaiverOrder(r){const ids=r.players.map(p=>p.id);r.waiverOrder=r.round%2===0?[...ids].reverse():ids;r.waiverIndex=0;skipWaiver(r);}
function skipWaiver(r){while(r.waiverIndex<r.waiverOrder.length && r.players.find(p=>p.id===r.waiverOrder[r.waiverIndex]).picks.length>=r.settings.maxPicks)r.waiverIndex++;if(r.waiverIndex>=r.waiverOrder.length){if(r.round>=r.settings.maxPicks || r.taken.length>=roster(r).length){r.stage='done';return;}r.round++;setWaiverOrder(r);}}
function makeLotteries(r){const groups=new Map();for(const pId of r.auctionTeams){const c=r.submissions[pId];if(!groups.has(c))groups.set(c,[]);groups.get(c).push(pId);}r.pendingLots=[];r.auctionWinners=[];for(const [cId,teamIds] of groups){if(teamIds.length===1){award(r,teamIds[0],cId,'単独指名');r.auctionWinners.push(teamIds[0]);}else{r.pendingLots.push({candidate:cId,teams:teamIds});}}beginNextLot(r);}
function award(r,pId,cId,method){if(r.taken.includes(cId))fail('指名済みの選手だよ');const p=r.players.find(x=>x.id===pId),c=all.find(x=>x.id===cId);p.picks.push(cId);r.taken.push(cId);r.history.push({round:r.round,team:pId,candidate:c,method});}
function beginNextLot(r){if(r.pendingLots.length){const next=r.pendingLots.shift();r.stage='lottery';r.lottery={...next,drawIndex:0,draws:[],winnerEnvelope:randomInt(next.teams.length),revealed:false};}else{const losers=r.auctionTeams.filter(id=>!r.auctionWinners.includes(id));if(losers.length)startAuction(r,losers);else startWaiver(r);}}
async function handle(req,res){const url=new URL(req.url,'http://localhost');if(req.method==='GET'&&url.pathname==='/'){const html=await readFile(path.join(here,'index.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}if(req.method==='GET'&&url.pathname==='/api/meta')return send(res,200,{works:Object.entries(works).map(([id,w])=>({id,label:w.label,school:w.school,count:w.names.length}))});if(req.method==='GET'&&url.pathname==='/api/events'){const r=rooms.get(url.searchParams.get('room'));if(!r)return send(res,404,{error:'ルームが見つからないよ'});res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});res.write('data: {"ready":true}\n\n');r.watchers.add(res);req.on('close',()=>r.watchers.delete(res));return;}
if(req.method==='GET'&&url.pathname==='/api/state'){const r=rooms.get(url.searchParams.get('room'));if(!r)fail('ルームが見つからないよ',404);return send(res,200,publicRoom(r,url.searchParams.get('token')));}
if(req.method!=='POST'||!url.pathname.startsWith('/api/'))fail('リクエストが見つからないよ',404);
let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)fail('データが大きすぎるよ');}const b=JSON.parse(body||'{}');
if(url.pathname==='/api/create'){const groups=Array.isArray(b.groups)?b.groups.filter(x=>works[x]):[];const teams=Number(b.teams),maxPicks=Number(b.maxPicks);if(!groups.length||!Number.isInteger(teams)||teams<2||teams>12||![3,5,7,10].includes(maxPicks))fail('設定を確認してね');const count=all.filter(x=>groups.includes(x.group)).length;if(count<teams*maxPicks)fail('指名枠に対して候補が足りないよ');const token=id(),p={id:id(),token,name:String(b.name||'ホスト').slice(0,24),picks:[]};let c=code();while(rooms.has(c))c=code();const r={code:c,settings:{groups,teams,maxPicks},players:[p],stage:'lobby',round:1,taken:[],history:[],auctionTeams:[],submissions:{},watchers:new Set(),announcement:null};rooms.set(c,r);return send(res,200,{code:c,token});}
if(url.pathname==='/api/join'){const r=rooms.get(String(b.code||'').toUpperCase());if(!r)fail('ルームが見つからないよ',404);if(r.stage!=='lobby')fail('すでにドラフトが始まってるよ');if(r.players.length>=r.settings.teams)fail('満員だよ');const token=id(),p={id:id(),token,name:String(b.name||'球団').slice(0,24),picks:[]};r.players.push(p);push(r);return send(res,200,{code:r.code,token});}
const r=rooms.get(String(b.code||'').toUpperCase());if(!r)fail('ルームが見つからないよ',404);const p=findPlayer(r,b.token);const candidate=x=>roster(r).some(c=>c.id===x);
switch(url.pathname){
case '/api/start':assertHost(r,p);if(r.stage!=='lobby'||r.players.length!==r.settings.teams)fail('全員揃ってから開始しよう');r.round=1;startAuction(r,r.players.map(x=>x.id));break;
case '/api/bid':if(r.stage!=='auction')fail('今は入札できないよ');stillEligible(r,p);if(!candidate(b.candidate)||r.taken.includes(b.candidate))fail('候補者を選び直してね');r.submissions[p.id]=b.candidate;if(r.auctionTeams.every(x=>r.submissions[x])){r.stage='reveal';r.queue=r.auctionTeams.map(t=>({team:t,candidate:all.find(c=>c.id===r.submissions[t])}));r.queueIndex=0;r.announcement=null;}break;
case '/api/reveal':assertHost(r,p);if(r.stage!=='reveal')fail('今は発表中じゃないよ');if(r.queueIndex<r.queue.length){r.announcement=r.queue[r.queueIndex++];}else{makeLotteries(r);}break;
case '/api/draw':if(r.stage!=='lottery')fail('今は抽選中じゃないよ');{const l=r.lottery;if(l.teams[l.drawIndex]!==p.id)fail('まだキミの抽選順じゃないよ');const envelope=Number(b.envelope);if(!Number.isInteger(envelope)||envelope<0||envelope>=l.teams.length||l.draws.some(x=>x.envelope===envelope))fail('別の封筒を選んでね');l.draws.push({team:p.id,envelope,opened:false,win:envelope===l.winnerEnvelope});}break;
case '/api/open':if(r.stage!=='lottery')fail('今は抽選中じゃないよ');{const l=r.lottery;const d=l.draws[l.drawIndex];if(!d||d.team!==p.id||d.opened)fail('いまは開封できないよ');d.opened=true;l.drawIndex++;if(d.win){award(r,p.id,l.candidate,'抽選当選');r.auctionWinners.push(p.id);}if(l.drawIndex===l.teams.length)l.revealed=true;}break;
case '/api/next-lottery':assertHost(r,p);if(r.stage!=='lottery'||!r.lottery.revealed)fail('抽選の終了を確認してね');beginNextLot(r);break;
case '/api/waiver':if(r.stage!=='waiver'||r.waiverOrder[r.waiverIndex]!==p.id)fail('まだキミの指名順じゃないよ');if(!candidate(b.candidate)||r.taken.includes(b.candidate))fail('候補者を選び直してね');award(r,p.id,b.candidate,'ウェーバー');r.waiverIndex++;skipWaiver(r);break;
default:fail('操作が見つからないよ',404);
}push(r);send(res,200,{ok:true});}
function send(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj));}
const server=http.createServer((req,res)=>handle(req,res).catch(e=>send(res,e.status||500,{error:e.status?e.message:'サーバーエラー: '+e.message})));
server.listen(PORT,'0.0.0.0',()=>console.log('Love Live Draft running on http://localhost:'+PORT));
