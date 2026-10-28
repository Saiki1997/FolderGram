// Several Telegram accounts, one at a time. Each account has its own data folder: login session, settings, upload
// queue, history, naming memory, folder syncs and logs. The first account keeps the original folder, so data from
// earlier versions needs no moving. Switching account restarts FolderGram on the other folder, so nothing of one
// account (a session, a queue, a flood wait) can leak into the other.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');

const FILE = 'accounts.json';
const MAIN = 'main';

class Accounts {
  /** root: the app's own data folder (Electron's userData). */
  constructor(root) {
    this.root = root;
    this.file = path.join(root, FILE);
    const d = readJson(this.file, null);
    this.data = d && Array.isArray(d.list) ? d : { active: MAIN, list: [] };
    if (!this.data.list.some((a) => a.id === MAIN)) this.data.list.unshift({ id: MAIN, name: 'Account 1', createdAt: Date.now() });
    if (!this.get(this.data.active)) this.data.active = MAIN;
  }

  list() { return this.data.list.map((a) => ({ ...a, dir: this.dirOf(a.id), active: a.id === this.data.active })); }
  get(id) { return this.data.list.find((a) => a.id === id) || null; }
  get active() { return this.get(this.data.active); }

  /** The data folder of an account: the original folder for the first one, accounts/<id> for the others. */
  dirOf(id) { return id === MAIN ? this.root : path.join(this.root, 'accounts', id); }
  activeDir() { return this.dirOf(this.data.active); }

  add(name) {
    const id = `a${crypto.randomBytes(5).toString('hex')}`;
    const clean = String(name || '').trim().slice(0, 60) || `Account ${this.data.list.length + 1}`;
    this.data.list.push({ id, name: clean, createdAt: Date.now() });
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    this.save();
    return this.get(id);
  }

  rename(id, name) {
    const a = this.get(id);
    if (!a) throw new Error('That account no longer exists.');
    a.name = String(name || '').trim().slice(0, 60) || a.name;
    this.save();
    return a;
  }

  /** Remembers who is logged in (name and @username only, never the session). */
  setIdentity(id, me) {
    const a = this.get(id);
    if (!a || !me) return;
    a.user = { name: String(me.name || '').slice(0, 80), username: me.username ? String(me.username).slice(0, 64) : null, bot: !!me.bot };
    this.save();
  }

  setActive(id) {
    if (!this.get(id)) throw new Error('That account no longer exists.');
    this.data.active = id;
    this.save();
  }

  /**
   * Takes an account off the list. Its login session files are deleted (so nobody can use them later); its other
   * data stays in its folder and the path is returned, so the user can look at it or delete it. The active account
   * and the first account cannot be removed.
   */
  remove(id) {
    if (id === MAIN) throw new Error('The first account can’t be removed. Log out of it instead.');
    if (id === this.data.active) throw new Error('Switch to another account before removing this one.');
    const a = this.get(id);
    if (!a) return null;
    const dir = this.dirOf(id);
    for (const f of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile() && /^session-.*\.dat(\.bak)?$/.test(x.name))) {
      fs.rmSync(path.join(dir, f.name), { force: true });
    }
    this.data.list = this.data.list.filter((x) => x.id !== id);
    this.save();
    return dir;
  }

  /**
   * Copies settings (never secrets, sessions, folders or the last group) and the naming rules, dictionary and
   * organization rules from one account into a new one. Learned names and topic mappings stay with their account.
   */
  copySettings(fromId, toId, secretKeys = []) {
    const from = this.dirOf(fromId);
    const to = this.dirOf(toId);
    const s = readJson(path.join(from, 'settings.json'), {}) || {};
    for (const k of [...secretKeys, 'apiId', 'phone', 'lastChat', 'sources']) delete s[k];
    writeJson(path.join(to, 'settings.json'), s, { backup: false });
    const naming = readJson(path.join(from, 'naming.json'), null);
    if (naming) writeJson(path.join(to, 'naming.json'), { rules: naming.rules || [], dictionary: naming.dictionary || [], organize: naming.organize || [] }, { backup: false });
  }

  save() { writeJson(this.file, this.data, { backup: false }); }
}

module.exports = { Accounts, MAIN, FILE };
