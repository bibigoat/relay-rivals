'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
    const symbols = ['◎', '◇', '✳', '⌁', '⊙'];
  const actionDefs = [
    { type: 'deploy', name: 'Deploy', description: '+1 influence', cost: 2, needsSector: true },
    { type: 'surge', name: 'Surge', description: '+3 influence', cost: 4, needsSector: true },
    { type: 'disrupt', name: 'Disrupt', description: '−2 enemy influence', cost: 3, needsSector: true },
    { type: 'charge', name: 'Charge', description: '+3 energy · cap 8', cost: 0 },
    { type: 'bank', name: 'Bank', description: '+2 points now', cost: 3 },
  ];
  let state = null;
  let roomCode = '';
  let identity = null;
  let selectedSector = null;
  let selectedTarget = '';
  let busy = false;
  let pollInFlight = false;
  let pollTimer = null;
  let lastSignature = '';
  let replay = null;
  let toastTimer;
  const session = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Private-mode storage can be unavailable. */ } },
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function same(a, b) { return String(a) === String(b); }
  function playerIndex(id, source = state) { return source.players.findIndex((p) => same(p.id, id)); }
  function myPlayer() { return state && identity ? state.players.find((p) => same(p.id, identity.playerId)) : null; }
  function myTurn() { return state?.status === 'playing' && identity && same(state.turnPlayerId, identity.playerId); }
  function influenceFor(sector, index, source = state) {
    if (Array.isArray(sector.influence)) return Number(sector.influence[index] || 0);
    return Number(sector.influence?.[source.players[index]?.id] || 0);
  }
  function sectorById(id, source = state) { return source.sectors.find((s) => same(s.id, id)); }
  function showError(where, message) { $(where).textContent = message; $(where).hidden = !message; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); }
  async function request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (options.auth) {
      if (!identity?.token) throw new Error('Join this room to take a seat first.');
      headers.Authorization = `Bearer ${identity.token}`;
    }
    const response = await fetch(path, { method: options.method || 'GET', headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`);
    return data;
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('#create-form button[type=submit], #join-form button[type=submit], #room-join-form button').forEach((b) => { b.disabled = value; });
    if (state) { renderActions(); $('start-button').disabled = value; }
  }
  function acceptIdentity(data) {
    roomCode = String(data.code || data.state.code);
    identity = { playerId: data.playerId, token: data.token };
    session.set(`relay-rivals:${roomCode}`, JSON.stringify(identity));
    session.set('relay-rivals:last-room', roomCode);
    openRoom(roomCode, data.state, identity);
  }
  function setEntryTab(tab) {
    const create = tab === 'create';
    $('create-form').hidden = !create; $('join-form').hidden = create;
    $('create-tab').classList.toggle('active', create); $('join-tab').classList.toggle('active', !create);
    $('create-tab').setAttribute('aria-selected', String(create)); $('join-tab').setAttribute('aria-selected', String(!create));
    showError('entry-error', '');
  }
  async function openRoom(code, initial, suppliedIdentity) {
    roomCode = code.trim().toUpperCase();
    identity = suppliedIdentity || null;
    try { identity = suppliedIdentity || JSON.parse(session.get(`relay-rivals:${roomCode}`)); } catch { /* Broken session data is treated as spectator mode. */ }
    $('welcome').hidden = true; $('game').hidden = false;
    history.replaceState(null, '', `/?room=${encodeURIComponent(roomCode)}`);
    $('room-code').textContent = roomCode;
    lastSignature = '';
    if (initial) render(initial);
    await poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1000);
  }
  async function poll() {
    if (!roomCode || pollInFlight) return;
    pollInFlight = true;
    const requestedRoom = roomCode;
    try {
      const result = await request(`/api/rooms/${encodeURIComponent(requestedRoom)}`);
      if (requestedRoom !== roomCode) return;
      render(result.state || result);
      if ($('game-error').dataset.connection === 'true') { showError('game-error', ''); delete $('game-error').dataset.connection; }
    } catch (error) {
      showError('game-error', error.message); $('game-error').dataset.connection = 'true';
    } finally { pollInFlight = false; }
  }
  function render(next) {
    if (state && same(next.code, state.code) && next.version < state.version) return;
    state = next;
    updateClock();
    const signature = JSON.stringify(next);
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (selectedSector !== null && !sectorById(selectedSector)) selectedSector = null;
    $('room-code').textContent = state.code;
    $('crew-count').textContent = `${state.players.length} / ${state.seats}`;
    $('round-current').textContent = String(state.round).padStart(2, '0');
    $('round-total').textContent = String(state.maxRounds || 8).padStart(2, '0');
    const current = state.players.find((p) => same(p.id, state.turnPlayerId));
    const host = identity && same(identity.playerId, state.hostPlayerId || state.players[0]?.id);
    const inLobby = state.status === 'lobby';
    const finished = state.status === 'finished';
    $('lobby-banner').hidden = !inLobby;
    $('start-button').hidden = !host;
    $('start-button').disabled = busy;
    $('lobby-message').textContent = host ? 'Invite your crew, or launch now. Empty seats become bots.' : 'Waiting for the host to launch. Empty seats will become bots.';
    $('spectator-join').hidden = !inLobby || !!myPlayer() || state.players.length >= state.seats;
    $('result-banner').hidden = !finished;
    $('turn-label').textContent = inLobby ? 'Waiting for launch' : finished ? 'Orbit complete' : myTurn() ? 'Your turn. Take control.' : `${current?.name || 'Next pilot'} is plotting a move`;
    $('turn-subtitle').textContent = inLobby ? 'Share the room code to invite your rivals.' : finished ? 'Open the flight recorder to revisit every move.' : myTurn() ? 'Pick a relay, then choose one action.' : 'Plan your next move while the orbit turns.';
    $('game-title').textContent = finished ? 'An orbit well contested.' : 'Make your next move.';
    if (finished) {
      const winners = state.players.filter((p) => (state.winnerIds || []).some((id) => same(id, p.id)));
      $('result-title').textContent = winners.length ? `${winners.map((p) => p.name).join(' & ')} ${winners.length > 1 ? 'share the win.' : 'wins the orbit.'}` : 'Mission complete.';
      $('result-detail').textContent = winners.length ? `${winners[0].score} points. Eight rounds of orbital ambition. Every decision is saved in the replay.` : 'The final scores are on the crew board. Every decision is saved in the replay.';
    }
    renderPlayers(); renderSectors(); renderTarget(); renderActions(); renderLog();
  }
  function renderPlayers() {
    const nodes = state.players.map((p, i) => {
      const card = el('article', `player-card${state.status === 'playing' && same(p.id, state.turnPlayerId) ? ' active' : ''}`);
      card.classList.add(`player-color-${i % 4}`);
      const top = el('div', 'player-top');
      top.append(el('span', 'player-initial', p.bot ? '⌘' : p.name.slice(0, 1).toUpperCase()), el('span', 'player-name', p.name), el('span', 'player-tag', identity && same(p.id, identity.playerId) ? 'YOU' : p.bot ? 'BOT' : 'PILOT'));
      const stats = el('div', 'player-stats');
      const score = el('span', 'player-score', p.score || 0); score.append(el('small', '', 'POINTS'));
      stats.append(score, el('span', 'player-energy', `⚡ ${p.energy || 0} / 8`)); card.append(top, stats);
      return card;
    });
    for (let i = state.players.length; i < state.seats; i++) nodes.push(el('div', 'empty-seat', `+ Open seat ${i + 1} · bot at launch`));
    $('players').replaceChildren(...nodes);
  }
  function renderSectors() {
    const focused = document.activeElement?.dataset.sector;
    const nodes = state.sectors.map((sector, i) => {
      const spotlight = same(sector.id, state.spotlight);
      const button = el('button', `sector${spotlight ? ' spotlight' : ''}${same(sector.id, selectedSector) ? ' selected' : ''}`);
      button.type = 'button'; button.dataset.sector = sector.id; button.setAttribute('aria-pressed', String(same(sector.id, selectedSector)));
      button.setAttribute('aria-label', `${sector.name}, ${sector.value + (spotlight ? 2 : 0)} points. Select relay.`);
      button.append(el('span', 'sector-number', `RELAY ${String(i + 1).padStart(2, '0')}`), el('span', 'sector-symbol', symbols[i]), el('span', 'sector-name', sector.name));
      const value = el('span', 'sector-value'); value.append(el('b', '', `${sector.value + (spotlight ? 2 : 0)} PTS`), document.createTextNode(' / ROUND')); button.append(value);
      const infs = state.players.map((p, index) => influenceFor(sector, index));
      const max = Math.max(1, ...infs);
      infs.forEach((amount, index) => {
        const track = el('span', `influence-track player-color-${index % 4}`);
        track.title = `${state.players[index].name}: ${amount} influence`;
        const meter = el('progress', 'influence-meter'); meter.max = Math.max(5, max); meter.value = amount; meter.setAttribute('aria-label', `${state.players[index].name}: ${amount} influence`);
        track.append(el('i', 'influence-dot'), meter, el('span', 'influence-value', amount)); button.append(track);
      });
      const highest = Math.max(0, ...infs); const leaders = state.players.filter((p, index) => infs[index] === highest && highest > 0);
      const owner = el('span', 'sector-owner', highest === 0 ? 'UNCLAIMED' : leaders.length === 1 ? `${leaders[0].name} leads` : 'TIED · NO POINTS');
      owner.title = owner.textContent; button.append(owner);
      button.addEventListener('click', () => { selectedSector = sector.id; renderSectors(); renderTarget(); renderActions(); });
      return button;
    });
    $('sectors').replaceChildren(...nodes);
    if (focused !== undefined) nodes.find((node) => node.dataset.sector === focused)?.focus({ preventScroll: true });
  }
  function renderTarget() {
    const targets = state.players.filter((p) => !identity || !same(p.id, identity.playerId));
    const nodes = [el('option', '', 'Choose an opponent')]; nodes[0].value = '';
    const sector = selectedSector === null ? null : sectorById(selectedSector);
    targets.forEach((p) => { const count = sector ? influenceFor(sector, playerIndex(p.id)) : 0; const option = el('option', '', `${p.name}${sector ? ` · ${count} influence` : ''}`); option.value = p.id; nodes.push(option); });
    if (!targets.some((p) => same(p.id, selectedTarget))) selectedTarget = '';
    $('target-player').replaceChildren(...nodes); $('target-player').value = selectedTarget;
    $('target-control').hidden = state.status !== 'playing' || !myPlayer() || selectedSector === null;
  }
  function disabledReason(action) {
    if (busy) return 'Sending your move…';
    if (state.status === 'lobby') return 'Available after launch';
    if (state.status === 'finished') return 'Match complete';
    if (!myPlayer()) return 'Spectators cannot move';
    if (!myTurn()) return 'Wait for your turn';
    if (myPlayer().energy < action.cost) return `Need ${action.cost} energy`;
    if (action.needsSector && selectedSector === null) return 'Select a relay first';
    if (action.type === 'disrupt') {
      if (!selectedTarget) return 'Choose an opponent above';
      const sector = sectorById(selectedSector);
      if (!sector || influenceFor(sector, playerIndex(selectedTarget)) < 1) return 'No enemy influence here';
    }
    if (action.type === 'charge' && myPlayer().energy >= 8) return 'Energy is already full';
    return '';
  }
  function renderActions() {
    if (!state) return;
    const sector = selectedSector === null ? null : sectorById(selectedSector);
    $('action-title').textContent = sector ? `${sector.name} selected. What’s the move?` : 'Choose your relay. Make it count.';
    $('energy-balance').textContent = myPlayer() ? `⚡ ${myPlayer().energy} / 8` : '⚡ —';
    const focusedAction = document.activeElement?.dataset.action;
    const nodes = actionDefs.map((action) => {
      const reason = disabledReason(action); const button = el('button', 'action-button'); button.type = 'button'; button.dataset.action = action.type;
      button.disabled = !!reason; button.title = reason || action.description;
      button.append(el('span', '', action.name), el('small', '', reason || action.description), el('span', 'action-cost', action.cost ? `${action.cost} ENERGY` : 'FREE'));
      button.addEventListener('click', () => sendAction(action)); return button;
    });
    $('actions').replaceChildren(...nodes);
    if (focusedAction !== undefined) nodes.find((node) => node.dataset.action === focusedAction && !node.disabled)?.focus({ preventScroll: true });
    $('action-hint').textContent = state.status === 'finished' ? 'The flight recorder holds the full story. Download it or play another orbit.' : myTurn() ? 'One action per turn. A tied relay pays nothing. Sometimes the best move is saving energy.' : state.status === 'lobby' ? 'Your first move starts with 4 energy. Empty seats become bots when the host launches.' : !myPlayer() ? 'Spectator view. Follow every move live, then explore the replay.' : 'Your flight plan stays selected while other pilots move.';
  }
  async function sendAction(action) {
    if (disabledReason(action)) return;
    const body = { type: action.type, expectedVersion: state.version };
    if (action.needsSector) body.sector = selectedSector;
    if (action.type === 'disrupt') body.targetPlayer = selectedTarget;
    showError('game-error', ''); setBusy(true);
    try { const data = await request(`/api/rooms/${encodeURIComponent(roomCode)}/actions`, { method: 'POST', auth: true, body }); render(data.state || data); }
    catch (error) { showError('game-error', error.message); await poll(); }
    finally { setBusy(false); }
  }
  function renderLog() {
    const entries = (state.log || []).slice(-20).reverse();
    const nodes = entries.map((entry, index) => { const row = el('li'); row.append(el('span', 'log-index', String((state.log || []).length - index).padStart(2, '0')), el('span', '', typeof entry === 'string' ? entry : entry.text)); return row; });
    $('match-log').replaceChildren(...(nodes.length ? nodes : [el('li', 'muted', 'Your story starts at launch.')]));
  }
  function updateClock() {
    const deadline = typeof state?.deadline === 'string' ? Date.parse(state.deadline) : state?.deadline;
    const seconds = state?.status === 'playing' && deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
    $('clock-seconds').textContent = seconds === null ? '—' : String(seconds).padStart(2, '0');
    $('turn-clock').classList.toggle('urgent', seconds !== null && seconds <= 4);
  }
  function reset() {
    clearInterval(pollTimer); roomCode = ''; state = null; identity = null; selectedSector = null; selectedTarget = ''; lastSignature = '';
    history.replaceState(null, '', '/'); $('game').hidden = true; $('welcome').hidden = false; setEntryTab('create'); window.scrollTo({ top: 0, behavior: 'smooth' });
    updateResume();
  }
  function updateResume() { const code = session.get('relay-rivals:last-room'); $('resume-button').hidden = !code; if (code) $('resume-button').textContent = `Continue room ${code} →`; }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast(label); }
    catch { const input = el('textarea'); input.value = text; input.className = 'clipboard-input'; document.body.append(input); input.select(); const ok = document.execCommand('copy'); input.remove(); toast(ok ? label : 'Copy unavailable. The room code is shown above.'); }
  }
  function openDialog(id) { if (typeof $(id).showModal === 'function') $(id).showModal(); else $(id).setAttribute('open', ''); }
  async function loadReplay() {
    openDialog('replay-dialog'); $('replay-summary').textContent = 'Loading the flight recorder…'; $('replay-download').disabled = true;
    replay = null; $('replay-players').replaceChildren(); $('replay-sectors').replaceChildren();
    $('replay-event').textContent = ''; $('replay-position').textContent = '0 / 0';
    $('replay-step').value = '0'; $('replay-step').max = '0'; $('replay-step').disabled = true;
    try {
      replay = await request(`/api/rooms/${encodeURIComponent(roomCode)}/replay`);
      $('replay-step').max = String(replay.events.length); $('replay-step').value = String(replay.events.length);
      $('replay-step').disabled = replay.events.length === 0;
      $('replay-summary').textContent = `${replay.events.length} recorded moves in room ${roomCode}. Drag through the timeline to see how the orbit changed.`;
      $('replay-download').disabled = !replay.initial;
      if (!replay.initial) $('replay-summary').textContent = 'No moves yet. Launch the match to start recording; every move will appear here automatically.';
      renderReplay();
    } catch (error) { $('replay-summary').textContent = error.message; }
  }
  function renderReplay() {
    if (!replay) return;
    const index = Number($('replay-step').value); const event = index ? replay.events[index - 1] : null;
    const snapshot = event?.state || (index === replay.events.length ? replay.final : replay.initial);
    $('replay-position').textContent = `${index} / ${replay.events.length}`;
    $('replay-event').textContent = event?.text || (replay.initial ? 'Launch state. All pilots start with 4 energy and 0 points.' : 'Waiting for launch. Invite your crew or let the host fill the empty seats with bots.');
    if (!snapshot) return;
    $('replay-players').replaceChildren(...snapshot.players.map((p, i) => { const card = el('div', 'replay-player'); card.classList.add(`player-color-${i % 4}`); const score = el('div', 'replay-player-score', p.score); score.append(el('small', '', `PTS · ${p.energy}⚡`)); card.append(el('div', 'replay-player-name', p.name), score); return card; }));
    $('replay-sectors').replaceChildren(...snapshot.sectors.map((sector) => { const card = el('div', `replay-sector${same(sector.id, snapshot.spotlight) ? ' spotlight' : ''}`, sector.name); snapshot.players.forEach((p, i) => { const line = el('p', '', `${p.name}: ${influenceFor(sector, i, snapshot)}`); line.classList.add(`player-color-${i % 4}`); card.append(line); }); return card; }));
  }
  $('create-tab').addEventListener('click', () => setEntryTab('create'));
  $('join-tab').addEventListener('click', () => setEntryTab('join'));
  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const name = $('create-name').value.trim(); if (!name) return;
    setBusy(true); showError('entry-error', '');
    try { acceptIdentity(await request('/api/rooms', { method: 'POST', body: { name, seats: Number(new FormData(event.target).get('seats')) } })); }
    catch (error) { showError('entry-error', error.message); } finally { setBusy(false); }
  });
  $('join-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const name = $('join-name').value.trim(); const code = $('join-code').value.trim().toUpperCase(); if (!name || !code) return;
    setBusy(true); showError('entry-error', '');
    try { acceptIdentity(await request(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { name } })); }
    catch (error) { showError('entry-error', error.message); } finally { setBusy(false); }
  });
  $('room-join-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const name = $('room-join-name').value.trim(); if (!name) return;
    setBusy(true); showError('game-error', '');
    try { acceptIdentity(await request(`/api/rooms/${encodeURIComponent(roomCode)}/join`, { method: 'POST', body: { name } })); }
    catch (error) { showError('game-error', error.message); } finally { setBusy(false); }
  });
  $('start-button').addEventListener('click', async () => {
    setBusy(true); showError('game-error', '');
    try { const data = await request(`/api/rooms/${encodeURIComponent(roomCode)}/start`, { method: 'POST', auth: true, body: { fillBots: true } }); render(data.state || data); }
    catch (error) { showError('game-error', error.message); } finally { setBusy(false); }
  });
  $('target-player').addEventListener('change', (event) => { selectedTarget = event.target.value; renderActions(); });
  $('copy-code').addEventListener('click', () => copy(roomCode, 'Room code copied.'));
  $('copy-link').addEventListener('click', () => copy(`${location.origin}/?room=${encodeURIComponent(roomCode)}`, 'Invite link copied. Share it with your crew.'));
  $('new-match').addEventListener('click', reset); $('play-again').addEventListener('click', reset);
  $('resume-button').addEventListener('click', () => openRoom(session.get('relay-rivals:last-room')));
  $('rules-open').addEventListener('click', () => openDialog('rules-dialog'));
  $('api-open').addEventListener('click', () => openDialog('api-dialog'));
  document.querySelectorAll('.close-modal').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
  $('replay-open').addEventListener('click', loadReplay); $('replay-step').addEventListener('input', renderReplay);
  $('replay-download').addEventListener('click', () => { if (!replay) return; const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = `relay-rivals-${roomCode}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  setInterval(updateClock, 250); updateResume();
  const queryRoom = new URLSearchParams(location.search).get('room');
  if (queryRoom && /^[A-Za-z0-9_-]{1,16}$/.test(queryRoom)) openRoom(queryRoom);
})();
