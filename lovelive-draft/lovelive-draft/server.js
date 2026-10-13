import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const works = {
  muse: { label: 'μ’s', school: '国立音ノ木坂学院', names: ['高坂穂乃果', '絢瀬絵里', '南ことり', '園田海未', '星空凛', '西木野真姫', '東條希', '小泉花陽', '矢澤にこ'] },
  aqours: { label: 'Aqours', school: '私立浦の星女学院', names: ['高海千歌', '桜内梨子', '松浦果南', '黒澤ダイヤ', '渡辺曜', '津島善子', '国木田花丸', '小原鞠莉', '黒澤ルビィ'] },
  niji: { label: '虹ヶ咲', school: '虹ヶ咲学園', names: ['上原歩夢', '中須かすみ', '桜坂しずく', '朝香果林', '宮下愛', '近江彼方', '優木せつ菜', 'エマ・ヴェルデ', '天王寺璃奈', '三船栞子', 'ミア・テイラー', '鐘嵐珠'] },
  liella: { label: 'Liella!', school: '結ヶ丘女子高等学校', names: ['澁谷かのん', '唐可可', '嵐千砂都', '平安名すみれ', '葉月恋', '桜小路きな子', '米女メイ', '若菜四季', '鬼塚夏美', 'ウィーン・マルガレーテ', '鬼塚冬毬'] },
  hasu: { label: '蓮ノ空（104期）', school: '蓮ノ空女学院', names: ['日野下花帆', '村野さやか', '乙宗梢', '夕霧綴理', '大沢瑠璃乃', '藤島慈', '百生吟子', '徒町小鈴', '安養寺姫芽'] }
};

const all = Object.entries(works).flatMap(([group, w]) =>
  w.names.map((name, i) => ({ id: `${group}-${i}`, group, groupLabel: w.label, school: w.school, name }))
);

const rooms = new Map();
const id = () => randomBytes(15).toString('hex');
const code = () => randomBytes(4).toString('hex').toUpperCase();

function roster(room) {
  return all.filter((x) => room.settings.groups.includes(x.group));
}

function publicRoom(room, token) {
  const self = room.players.find((p) => p.token === token);
  return {
    code: room.code,
    settings: room.settings,
    players: room.players.map((p) => ({ id: p.id, name: p.name, picks: p.picks })),
    selfId: self?.id,
    host: self?.id === room.players[0]?.id,
    stage: room.stage,
    round: room.round,
    announcement: room.announcement,
    queue: room.queue,
    queueIndex: room.queueIndex,
    submitted: room.stage === 'auction' ? room.auctionTeams.filter((x) => room.submissions[x]).length : 0,
    required: room.auctionTeams.length,
    submittedMine: !!room.submissions[self?.id],
    auctionTeams: room.auctionTeams,
    lottery: room.lottery
      ? {
          candidate: room.lottery.candidate,
          teams: room.lottery.teams,
          drawIndex: room.lottery.drawIndex,
          draws: room.lottery.draws.map((x) => ({
            team: x.team,
            envelope: x.envelope,
            opened: x.opened,
            win: x.opened ? x.win : undefined
          })),
          revealed: room.lottery.revealed
        }
      : null,
    waiverTurn: room.waiverOrder?.[room.waiverIndex],
    history: room.history,
    candidates: roster(room).filter((c) => !room.taken.includes(c.id)),
    taken: room.taken
  };
}

function push(room) {
  for (const res of room.watchers) {
    try {
      res.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
    } catch {
      room.watchers.delete(res);
    }
  }
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function assertHost(room, player) {
  if (room.players[0]?.id !== player.id) fail('ホストだけが操作できるよ');
}

function findPlayer(room, token) {
  const player = room.players.find((x) => x.token === token);
  if (!player) fail('このルームの参加情報がないよ', 403);
  return player;
}

function stillEligible(room, player) {
  if (!room.auctionTeams.includes(player.id)) fail('今回の入札対象外だよ');
}

function getCandidateById(candidateId) {
  return all.find((c) => c.id === candidateId);
}

function startAuction(room, teamIds) {
  room.stage = 'auction';
  room.auctionTeams = teamIds;
  room.submissions = {};
  room.queue = [];
  room.queueIndex = 0;
  room.announcement = null;
  room.lottery = null;
}

function startWaiver(room) {
  room.round = 2;
  room.stage = 'waiver';
  room.announcement = null;
  room.waiverIndex = 0;
  setWaiverOrder(room);
}

function setWaiverOrder(room) {
  const ids = room.players.map((p) => p.id);
  room.waiverOrder = room.round % 2 === 0 ? [...ids].reverse() : ids;
  room.waiverIndex = 0;
  skipWaiver(room);
}

function skipWaiver(room) {
  while (
    room.waiverIndex < room.waiverOrder.length &&
    room.players.find((p) => p.id === room.waiverOrder[room.waiverIndex]).picks.length >= room.settings.maxPicks
  ) {
    room.waiverIndex++;
  }

  if (room.waiverIndex >= room.waiverOrder.length) {
    if (room.round >= room.settings.maxPicks || room.taken.length >= roster(room).length) {
      room.stage = 'done';
      room.announcement = null;
      return;
    }
    room.round++;
    setWaiverOrder(room);
  }
}

function makeLotteries(room) {
  const groups = new Map();
  for (const playerId of room.auctionTeams) {
    const candidateId = room.submissions[playerId];
    if (!groups.has(candidateId)) groups.set(candidateId, []);
    groups.get(candidateId).push(playerId);
  }

  room.pendingLots = [];
  room.auctionWinners = [];

  for (const [candidateId, teamIds] of groups) {
    if (teamIds.length === 1) {
      award(room, teamIds[0], candidateId, '単独指名');
      room.auctionWinners.push(teamIds[0]);
    } else {
      room.pendingLots.push({ candidate: candidateId, teams: teamIds });
    }
  }

  beginNextLot(room);
}

function award(room, playerId, candidateId, method) {
  if (room.taken.includes(candidateId)) fail('指名済みの選手だよ');
  const player = room.players.find((x) => x.id === playerId);
  const candidate = getCandidateById(candidateId);
  player.picks.push(candidateId);
  room.taken.push(candidateId);
  room.history.push({ round: room.round, team: playerId, candidate, method });
}

function beginNextLot(room) {
  if (room.pendingLots.length) {
    const next = room.pendingLots.shift();
    room.stage = 'lottery';
    room.lottery = {
      ...next,
      drawIndex: 0,
      draws: [],
      winnerEnvelope: randomInt(next.teams.length),
      revealed: false
    };
    room.announcement = null;
  } else {
    const losers = room.auctionTeams.filter((playerId) => !room.auctionWinners.includes(playerId));
    if (losers.length) startAuction(room, losers);
    else startWaiver(room);
  }
}

function advanceWaiver(room) {
  room.waiverIndex++;
  skipWaiver(room);
  if (room.stage !== 'done') {
    room.stage = 'waiver';
    room.announcement = null;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    const html = await readFile(path.join(here, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/meta') {
    return send(res, 200, {
      works: Object.entries(works).map(([workId, work]) => ({
        id: workId,
        label: work.label,
        school: work.school,
        count: work.names.length
      }))
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get(url.searchParams.get('room'));
    if (!room) return send(res, 404, { error: 'ルームが見つからないよ' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write('data: {"ready":true}\n\n');
    room.watchers.add(res);
    req.on('close', () => room.watchers.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const room = rooms.get(url.searchParams.get('room'));
    if (!room) fail('ルームが見つからないよ', 404);
    return send(res, 200, publicRoom(room, url.searchParams.get('token')));
  }

  if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
    fail('リクエストが見つからないよ', 404);
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) fail('データが大きすぎるよ');
  }
  const payload = JSON.parse(body || '{}');

  if (url.pathname === '/api/create') {
    const groups = Array.isArray(payload.groups) ? payload.groups.filter((x) => works[x]) : [];
    const teams = Number(payload.teams);
    const maxPicks = Number(payload.maxPicks);
    if (!groups.length || !Number.isInteger(teams) || teams < 2 || teams > 12 || ![3, 5, 7, 10].includes(maxPicks)) {
      fail('設定を確認してね');
    }
    const count = all.filter((x) => groups.includes(x.group)).length;
    if (count < teams * maxPicks) fail('指名枠に対して候補が足りないよ');

    const token = id();
    const host = { id: id(), token, name: String(payload.name || 'ホスト').slice(0, 24), picks: [] };
    let roomCode = code();
    while (rooms.has(roomCode)) roomCode = code();

    const room = {
      code: roomCode,
      settings: { groups, teams, maxPicks },
      players: [host],
      stage: 'lobby',
      round: 1,
      taken: [],
      history: [],
      auctionTeams: [],
      submissions: {},
      watchers: new Set(),
      announcement: null,
      queue: [],
      queueIndex: 0,
      lottery: null,
      pendingLots: [],
      auctionWinners: [],
      waiverOrder: [],
      waiverIndex: 0
    };
    rooms.set(roomCode, room);
    return send(res, 200, { code: roomCode, token });
  }

  if (url.pathname === '/api/join') {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    if (!room) fail('ルームが見つからないよ', 404);
    if (room.stage !== 'lobby') fail('すでにドラフトが始まってるよ');
    if (room.players.length >= room.settings.teams) fail('満員だよ');
    const token = id();
    const player = { id: id(), token, name: String(payload.name || '球団').slice(0, 24), picks: [] };
    room.players.push(player);
    push(room);
    return send(res, 200, { code: room.code, token });
  }

  const room = rooms.get(String(payload.code || '').toUpperCase());
  if (!room) fail('ルームが見つからないよ', 404);
  const player = findPlayer(room, payload.token);
  const candidateExists = (candidateId) => roster(room).some((candidate) => candidate.id === candidateId);

  switch (url.pathname) {
    case '/api/leave': {
      if (room.stage !== 'lobby') fail('開始後は参加枠を退出できないよ');
      if (room.players[0].id === player.id) {
        rooms.delete(room.code);
        for (const watcher of room.watchers) watcher.end();
        return send(res, 200, { ok: true, closed: true });
      }
      room.players = room.players.filter((x) => x.id !== player.id);
      break;
    }
    case '/api/start': {
      assertHost(room, player);
      if (room.stage !== 'lobby' || room.players.length !== room.settings.teams) {
        fail('全員揃ってから開始しよう');
      }
      room.round = 1;
      startAuction(room, room.players.map((x) => x.id));
      break;
    }
    case '/api/bid': {
      if (room.stage !== 'auction') fail('今は入札できないよ');
      stillEligible(room, player);
      if (!candidateExists(payload.candidate) || room.taken.includes(payload.candidate)) fail('候補者を選び直してね');
      room.submissions[player.id] = payload.candidate;
      if (room.auctionTeams.every((x) => room.submissions[x])) {
        room.stage = 'reveal';
        room.queue = room.auctionTeams.map((teamId) => ({
          team: teamId,
          candidate: getCandidateById(room.submissions[teamId])
        }));
        room.queueIndex = 0;
        room.announcement = null;
      }
      break;
    }
    case '/api/reveal': {
      assertHost(room, player);
      if (room.stage !== 'reveal') fail('今は発表中じゃないよ');
      if (room.queueIndex < room.queue.length) {
        room.announcement = room.queue[room.queueIndex++];
      } else {
        makeLotteries(room);
      }
      break;
    }
    case '/api/draw': {
      if (room.stage !== 'lottery') fail('今は抽選中じゃないよ');
      const lottery = room.lottery;
      if (lottery.teams[lottery.drawIndex] !== player.id) fail('まだキミの抽選順じゃないよ');
      const envelope = Number(payload.envelope);
      if (!Number.isInteger(envelope) || envelope < 0 || envelope >= lottery.teams.length || lottery.draws.some((x) => x.envelope === envelope)) {
        fail('別の封筒を選んでね');
      }
      lottery.draws.push({ team: player.id, envelope, opened: false, win: envelope === lottery.winnerEnvelope });
      break;
    }
    case '/api/open': {
      if (room.stage !== 'lottery') fail('今は抽選中じゃないよ');
      const lottery = room.lottery;
      const draw = lottery.draws[lottery.drawIndex];
      if (!draw || draw.team !== player.id || draw.opened) fail('いまは開封できないよ');
      draw.opened = true;
      lottery.drawIndex++;
      if (draw.win) {
        award(room, player.id, lottery.candidate, '抽選当選');
        room.auctionWinners.push(player.id);
      }
      if (lottery.drawIndex === lottery.teams.length) lottery.revealed = true;
      break;
    }
    case '/api/next-lottery': {
      assertHost(room, player);
      if (room.stage !== 'lottery' || !room.lottery.revealed) fail('抽選の終了を確認してね');
      beginNextLot(room);
      break;
    }
    case '/api/waiver': {
      if (room.stage !== 'waiver' || room.waiverOrder[room.waiverIndex] !== player.id) fail('まだキミの指名順じゃないよ');
      if (!candidateExists(payload.candidate) || room.taken.includes(payload.candidate)) fail('候補者を選び直してね');
      award(room, player.id, payload.candidate, 'ウェーバー');
      room.stage = 'waiver-reveal';
      room.announcement = { team: player.id, candidate: getCandidateById(payload.candidate) };
      break;
    }
    case '/api/next-waiver': {
      assertHost(room, player);
      if (room.stage !== 'waiver-reveal') fail('今は次へ進めないよ');
      advanceWaiver(room);
      break;
    }
    default:
      if (![
        '/api/leave',
        '/api/start',
        '/api/bid',
        '/api/reveal',
        '/api/draw',
        '/api/open',
        '/api/next-lottery',
        '/api/waiver',
        '/api/next-waiver'
      ].includes(url.pathname)) {
        fail('操作が見つからないよ', 404);
      }
  }

  push(room);
  send(res, 200, { ok: true });
}

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) =>
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.status ? error.message : `サーバーエラー: ${error.message}`
    })
  )
);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Love Live Draft running on http://localhost:${PORT}`);
});
