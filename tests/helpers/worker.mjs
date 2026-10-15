/*
 * Runs a parser worker function (whatsAppParserWorker, telegramParserWorker…) in Node.
 * In the page each one is serialized into a Web Worker; here it gets a fake `self` and
 * the same lib (messageLib without VADER, plus zipLib), and its messages are collected.
 */
import { loadScripts, messageLib } from './load.mjs';

const { zipLib } = loadScripts(['zip.js'], ['zipLib']);

/** Resolves with { msgs, contacts, counts } or rejects with the worker's error. */
export function runParser(file, workerName, payload) {
  const worker = loadScripts([file], [workerName])[workerName];
  const lib = Object.assign(messageLib(), zipLib());
  const msgs = [];
  return new Promise((resolve, reject) => {
    const self = {
      postMessage(d) {
        if (d.type === 'batch') msgs.push(...d.msgs);
        else if (d.type === 'done') resolve({ msgs, contacts: d.contacts, counts: d.counts });
        else if (d.type === 'error') reject(new Error(d.message));
      },
    };
    worker(self, lib);
    self.onmessage({ data: payload });
  });
}
