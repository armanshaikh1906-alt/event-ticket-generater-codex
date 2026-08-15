import assert from 'node:assert/strict';
import fs from 'node:fs';

function eventEndDate(ev) {
  if (!ev?.endDate && !ev?.startDate) return null;
  const date = ev.endDate || ev.startDate;
  const time = ev.endTime || ev.startTime || '23:59';
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function eventEffectiveStatus(ev, now = new Date()) {
  if (!ev) return 'deleted';
  if (ev.deletedAt || ev.status === 'deleted') return 'deleted';
  if (ev.status === 'cancelled') return 'cancelled';
  const end = eventEndDate(ev);
  if (end && end < now) return 'completed';
  return ev.status || 'published';
}
function isEventCheckInAllowed(ev, now) { return eventEffectiveStatus(ev, now) === 'published'; }
function isEventIssuable(ev, now) { return eventEffectiveStatus(ev, now) === 'published'; }
function ticketScanPayload(t) { return JSON.stringify({app:'EventPass', uid:t.uid, eventId:t.eventId, ticketId:t.ticketId||t.id}); }
function parseTicketScan(raw) {
  const text = String(raw||'').trim();
  try { const data = JSON.parse(text); return {ticketId:String(data.ticketId||data.id||'').trim(), eventId:data.eventId||'', uid:data.uid||''}; }
  catch { return {ticketId:text, eventId:'', uid:''}; }
}
function processScanLikeImplementation({tid, gateEventId, currentUid, tickets}) {
  const parsed = parseTicketScan(tid);
  const gate = gateEventId || parsed.eventId;
  if (!gate) return {ok:false, code:'SELECT_EVENT'};
  if (parsed.uid && parsed.uid !== currentUid) return {ok:false, code:'WRONG_ORGANIZER'};
  const lookup = (parsed.ticketId||String(tid)).toUpperCase();
  const t = tickets.find(t=>((t.ticketId||'').toUpperCase()===lookup||t.id===lookup) && t.eventId===gate);
  if (!t) return {ok:false, code:'INVALID_TICKET'};
  return {ok:true, ticket:t};
}
class SerialStore {
  constructor({event, ticket}) { this.event = structuredClone(event); this.ticket = ticket ? structuredClone(ticket) : null; this.tickets = []; this.checkins = []; this.nextId=1; this.lock=Promise.resolve(); }
  runTransaction(fn) {
    const job = this.lock.then(async () => {
      const pending = {event:null, ticket:null, tickets:[], checkins:[]};
      const tx = {
        getEvent: async () => structuredClone(this.event),
        getTicket: async () => this.ticket ? structuredClone(this.ticket) : null,
        updateEvent: patch => { pending.event = {...this.event, ...patch}; },
        updateTicket: patch => { pending.ticket = {...this.ticket, ...patch}; },
        setTicket: data => { pending.tickets.push({id:`ticket-${this.nextId++}`, ...data}); },
        setCheckin: data => { pending.checkins.push(data); }
      };
      const result = await fn(tx);
      if (pending.event) this.event = pending.event;
      if (pending.ticket) this.ticket = pending.ticket;
      this.tickets.push(...pending.tickets);
      this.checkins.push(...pending.checkins);
      return result;
    });
    this.lock = job.catch(()=>{});
    return job;
  }
}
async function issueTicket(store, type) {
  return store.runTransaction(async tx => {
    const ev = await tx.getEvent();
    if (!isEventIssuable(ev)) throw new Error('EVENT_CLOSED');
    const idx = ev.ticketTypes.findIndex(tt=>tt.name===type);
    const remaining = ev.ticketTypes[idx].remaining ?? ev.ticketTypes[idx].quantity ?? 0;
    if (remaining <= 0) throw new Error('SOLD_OUT');
    tx.updateEvent({ticketTypes: ev.ticketTypes.map((tt,i)=>i===idx ? {...tt, remaining:remaining-1} : tt)});
    tx.setTicket({status:'active', ticketType:type});
    return true;
  });
}
async function checkInTicket(store, expectedEventId, uid) {
  return store.runTransaction(async tx => {
    const t = await tx.getTicket();
    if (t.uid !== uid) throw new Error('UNAUTHORIZED');
    if (expectedEventId && t.eventId !== expectedEventId) throw new Error('WRONG_EVENT');
    if (t.status === 'checked_in') throw new Error('ALREADY_CHECKED_IN');
    if (t.status !== 'active') throw new Error('INVALID_STATUS');
    const ev = await tx.getEvent();
    if (ev.uid !== uid) throw new Error('UNAUTHORIZED');
    if (!isEventCheckInAllowed(ev)) throw new Error(`EVENT_${eventEffectiveStatus(ev).toUpperCase()}`);
    tx.updateTicket({status:'checked_in', checkedInBy:uid, checkedInAt:'SERVER_TIMESTAMP'});
    tx.setCheckin({ticketDbId:t.id, checkedInBy:uid});
    return true;
  });
}
function eventTicketsHtml(ev, tickets) {
  const eventTickets = tickets.filter(t=>t.eventId===ev.id);
  return `<div class="sheet">${eventTickets.map(t=>`<div class="mini"><div>${t.ticketId}</div><div class="qr" data-qr="${encodeURIComponent(ticketScanPayload(t))}"></div></div>`).join('')}</div>`;
}

const eventA = {id:'eventA', uid:'org1', status:'published', startDate:'2026-08-15', endDate:'2026-08-15', startTime:'10:00', endTime:'23:00'};
const ticketA = {id:'dbA', uid:'org1', eventId:'eventA', ticketId:'TK-A', status:'active'};
const ticketB = {id:'dbB', uid:'org1', eventId:'eventB', ticketId:'TK-B', status:'active'};

const checkStore = new SerialStore({event:eventA, ticket:ticketA});
const checkResults = await Promise.allSettled(Array.from({length:10}, () => checkInTicket(checkStore, 'eventA', 'org1')));
assert.equal(checkResults.filter(r=>r.status==='fulfilled').length, 1);
assert.equal(checkResults.filter(r=>r.status==='rejected' && r.reason.message === 'ALREADY_CHECKED_IN').length, 9);
assert.equal(checkStore.checkins.length, 1);
assert.equal(checkStore.ticket.status, 'checked_in');

const issueStore = new SerialStore({event:{...eventA, ticketTypes:[{name:'General', quantity:1, remaining:1}]}});
const issueResults = await Promise.allSettled(Array.from({length:10}, () => issueTicket(issueStore, 'General')));
assert.equal(issueResults.filter(r=>r.status==='fulfilled').length, 1);
assert.equal(issueResults.filter(r=>r.status==='rejected').length, 9);
assert.equal(issueStore.tickets.length, 1);
assert.equal(issueStore.event.ticketTypes[0].remaining, 0);

assert.equal(processScanLikeImplementation({tid:ticketScanPayload(ticketA), gateEventId:'eventB', currentUid:'org1', tickets:[ticketA, ticketB]}).code, 'INVALID_TICKET');
assert.equal(isEventCheckInAllowed({...eventA, endDate:'2026-08-14'}, new Date('2026-08-15T12:00:00Z')), false);
assert.equal(isEventCheckInAllowed({...eventA, status:'cancelled'}), false);
assert.equal(isEventCheckInAllowed({...eventA, status:'deleted'}), false);

const html = eventTicketsHtml(eventA, [ticketA, ticketB, {...ticketA, id:'dbA2', ticketId:'TK-A2'}]);
assert.equal((html.match(/class="qr"/g)||[]).length, 2);
assert.ok(html.includes(encodeURIComponent(ticketScanPayload(ticketA))));
assert.ok(!html.includes('TK-B'));

const rules = fs.readFileSync('firestore.rules','utf8');
for (const required of ['allow read: if isOwnerUid(resource.data.uid)', 'request.resource.data.uid == resource.data.uid', 'request.resource.data.checkedInBy == request.auth.uid', 'allow delete: if false', 'existsAfter']) {
  assert.ok(rules.includes(required), `rules missing ${required}`);
}

console.log(JSON.stringify({checkIn:{successes:1, alreadyCheckedIn:9, checkins:1, finalStatus:'checked_in'}, issue:{successes:1, rejected:9, tickets:1, remaining:0}, wrongEvent:'REJECTED', lifecycle:'REJECTED', pdfQrCount:2, securityRulesStaticAssertions:'passed'}, null, 2));
