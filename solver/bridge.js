'use strict';

// Timefold tourne hors du thread HTTP. Le protocole JSON-lignes ne transporte
// que des identifiants opaques et des contraintes ; aucun QR, code KaraFun ou
// donnée de téléphone ne sort du PC. Une requête qui échoue laisse intact
// l'ordonnanceur local et ne peut pas déclencher d'envoi à KaraFun.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// En développement, le JAR fraîchement compilé prime sur un ancien JAR de
// kit laissé dans le dossier source. Le kit ne contient que le second chemin.
const JARS = [path.join(__dirname, 'target', 'karafun-solver.jar'),
  path.join(__dirname, 'karafun-solver.jar')];
const BUNDLED_JAVA = path.join(ROOT, 'solver-runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

class TimefoldBridge {
  constructor(options = {}) {
    this.jar = options.jar || JARS.find(fs.existsSync) || null;
    this.java = options.java || (fs.existsSync(BUNDLED_JAVA) ? BUNDLED_JAVA : 'java');
    this.spawn = options.spawn || spawn;
    // Garde minimale ; chaque calcul reçoit en plus son propre budget.
    this.timeoutMs = options.timeoutMs || 30000;
    this.settleMs = options.settleMs ?? 1000;
    this.startTimer = null;
    this.child = null;
    this.buffer = '';
    this.active = null;
    this.queued = null;
    this.disabledUntil = 0;
    this.lastError = this.jar ? null : 'JAR Timefold absent.';
  }

  get available() { return !!this.jar && Date.now() >= this.disabledUntil; }

  _start() {
    if (this.child) return;
    if (!this.available) throw new Error('Solveur Timefold indisponible.');
    const child = this.spawn(this.java, ['-jar', this.jar], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dorg.slf4j.simpleLogger.defaultLogLevel=warn' },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (this.child === child) this._receive(chunk); });
    child.stderr.on('data', () => { /* diagnostics locaux, jamais des secrets */ });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', error => { if (this.child === child) this._failed(error); });
    }
    child.on('error', error => { if (this.child === child) this._failed(error); });
    child.on('exit', () => {
      if (this.child === child) this._failed(new Error('Le solveur Timefold s’est arrêté.'));
    });
  }

  _stopChild() {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    if (!child) return;
    child.stdout.removeAllListeners('data');
    child.stderr.removeAllListeners('data');
    // Conserver les listeners `error` avec garde d'identité : Windows peut
    // encore signaler EPIPE ou une erreur du processus après kill().
    try { child.kill(); } catch (_) { /* déjà arrêté */ }
  }

  _failed(error) {
    this.lastError = error.message;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this._stopChild();
    this.disabledUntil = Date.now() + 30_000;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = null;
    }
    if (this.queued) {
      this.queued.reject(error);
      this.queued = null;
    }
  }

  _receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) {
      this._failed(new Error('Réponse Timefold trop grande.'));
      return;
    }
    for (let at; (at = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      const active = this.active;
      if (!active) continue;
      let response;
      try { response = JSON.parse(line); }
      catch (error) { this._failed(new Error('Réponse Timefold illisible.')); return; }
      // Un calcul interrompu par un état plus récent répond encore : ignoré.
      if (response.requestId !== active.request.requestId) continue;
      clearTimeout(active.timer);
      this.active = null;
      if (response.error) {
        this.lastError = response.error;
        active.reject(new Error(response.error));
      } else {
        this.lastError = null;
        active.resolve(response);
      }
    }
  }

  _pump() {
    if (!this.queued) return;
    const job = this.queued;
    this.queued = null;
    try {
      this._start();
      this.active = job;
      // Budget demandé + démarrage éventuel de la JVM : au-delà, le worker
      // est considéré bloqué et l'ordre local continue seul.
      const budget = Number(job.request?.budgetMs) || 15000;
      job.timer = setTimeout(() => this._failed(new Error('Délai du solveur Timefold dépassé.')),
        Math.max(this.timeoutMs, budget + 15000));
      this.child.stdin.write(JSON.stringify(job.request) + '\n');
    } catch (error) {
      if (this.active === job) this._failed(error);
      else job.reject(error);
    }
  }

  // Une soirée change vite : conserver seulement la dernière requête. Le
  // worker Java reste démarré ; la nouvelle ligne interrompt immédiatement la
  // recherche périmée (terminateEarly) et sa réponse éventuelle est ignorée.
  // `immediate` saute la fenêtre de regroupement (bouton Recalculer du bar).
  solve(request, { immediate = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new Error('Solveur Timefold indisponible.'));
      if (this.queued) this.queued.reject(new Error('Plan remplacé par un état plus récent.'));
      if (this.active) {
        clearTimeout(this.active.timer);
        this.active.reject(new Error('Plan remplacé par un état plus récent.'));
        this.active = null;
      }
      this.queued = { request, resolve, reject, timer: null };
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        this._pump();
      }, immediate ? 0 : this.settleMs);
    });
  }

  close() {
    this._failed(new Error('Solveur fermé.'));
    this.disabledUntil = Number.MAX_SAFE_INTEGER;
  }
}

module.exports = { TimefoldBridge, BUNDLED_JAVA };
