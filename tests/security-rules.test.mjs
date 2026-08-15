import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import fs from 'node:fs/promises';

const projectId = `eventpass-rules-${Date.now()}`;
const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { rules: await fs.readFile('firestore.rules', 'utf8') }
});

const ctxA = testEnv.authenticatedContext('orgA');
const ctxB = testEnv.authenticatedContext('orgB');
const admin = testEnv.unauthenticatedContext();
const dbA = ctxA.firestore();
const dbB = ctxB.firestore();

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'events/eventA'), {uid:'orgA', name:'A', status:'published', editCount:0, capacity:1, ticketTypes:[{name:'General', quantity:1, remaining:1}]});
  await setDoc(doc(db, 'events/eventB'), {uid:'orgB', name:'B', status:'published', editCount:0, capacity:1, ticketTypes:[{name:'General', quantity:1, remaining:1}]});
  await setDoc(doc(db, 'tickets/ticketA'), {uid:'orgA', eventId:'eventA', ticketId:'TK-A', status:'active', price:0, ticketType:'General', seat:'G-001'});
});

await assertSucceeds(getDoc(doc(dbA, 'events/eventA')));
await assertFails(getDoc(doc(dbA, 'events/eventB')));
await assertFails(updateDoc(doc(dbA, 'events/eventB'), {name:'hacked'}));
await assertFails(getDoc(doc(dbA, 'tickets/ticketB')));
await assertFails(updateDoc(doc(dbA, 'tickets/ticketA'), {uid:'orgB'}));
await assertFails(updateDoc(doc(dbA, 'tickets/ticketA'), {status:'checked_in'}));
await assertFails(updateDoc(doc(dbA, 'events/eventA'), {editCount:0}));
await assertFails(updateDoc(doc(dbA, 'events/eventA'), {ticketTypes:[{name:'General', quantity:1, remaining:99}]}));
await assertSucceeds(updateDoc(doc(dbA, 'tickets/ticketA'), {status:'checked_in', checkedInAt:serverTimestamp(), checkedInBy:'orgA', checkedInByName:'Org A'}));
await assertFails(updateDoc(doc(dbA, 'tickets/ticketA'), {status:'active', checkedInAt:serverTimestamp(), checkedInBy:'orgA', checkedInByName:'Org A'}));
await assertFails(deleteDoc(doc(dbA, 'events/eventA')));

await testEnv.cleanup();
console.log('security-rules-tests-passed');
