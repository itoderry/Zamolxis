/* ============================================================
   Zamolxis voice helpers (no build step, no DOM): the pieces of the
   Claude Voice app that run in the browser, ported to JS.
   - phrase matching: norm_word / apply_aliases / find_phrase with a
     difflib.SequenceMatcher ratio (claude_voice/textutil.py)
   - wake / stop / cancel rules (claude_voice/dictation.py)
   - clean_dictation / continue_case (textutil.py)
   - level-based utterance segmentation (claude_voice/audio.py)
   - 16-bit PCM WAV encoding
   Loaded as a classic script (window.ZxVoice) and by the node tests
   (module.exports).
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- text ----------
  var ACC_FROM = 'ăâîșşțţéèêëàâäôöûüùçÉÈÊËÀÂÄÔÖÛÜÙÇĂÂÎȘŞȚŢ';
  var ACC_TO = 'aaisstteeeeaaaoouuucEEEEAAAOOUUUCAAISSTT';
  var NON_WORD_SPACE = /[^\p{L}\p{N}_\s]/gu;   // Python re [^\w\s] (Unicode)
  var NON_WORD = /[^\p{L}\p{N}_]/gu;            // Python re [^\w]

  function normWord(w) {
    var s = '', low = String(w == null ? '' : w).toLowerCase();
    for (var ch of low) { var i = ACC_FROM.indexOf(ch); s += i >= 0 ? ACC_TO[i] : ch; }
    return s.replace(NON_WORD_SPACE, '');
  }
  function splitWs(text) { var t = String(text == null ? '' : text).trim(); return t ? t.split(/\s+/) : []; }
  /** [original tokens, normalized tokens], aligned 1:1. */
  function tokens(text) { var orig = splitWs(text); return [orig, orig.map(normWord)]; }
  /** Map misheard forms of the name to the name token. */
  function applyAliases(norm, aliases, name) {
    var set = {}; (aliases || []).forEach(function (a) { set[normWord(a)] = 1; });
    return norm.map(function (t) { return set[t] ? name : t; });
  }

  // difflib.SequenceMatcher(None, a, b).ratio(), including the autojunk rule for len(b) >= 200.
  function ratio(a, b) {
    a = Array.from(String(a)); b = Array.from(String(b));
    var la = a.length, lb = b.length;
    if (!la && !lb) return 1;
    var b2j = {};
    for (var j = 0; j < lb; j++) { (b2j[b[j]] = b2j[b[j]] || []).push(j); }
    if (lb >= 200) {
      var ntest = Math.floor(lb / 100) + 1;
      Object.keys(b2j).forEach(function (k) { if (b2j[k].length > ntest) delete b2j[k]; });
    }
    function longest(alo, ahi, blo, bhi) {
      var besti = alo, bestj = blo, bestsize = 0, j2len = {};
      for (var i = alo; i < ahi; i++) {
        var nj = {}, js = Object.prototype.hasOwnProperty.call(b2j, a[i]) ? b2j[a[i]] : [];
        for (var x = 0; x < js.length; x++) {
          var jj = js[x];
          if (jj < blo) continue;
          if (jj >= bhi) break;
          var k = nj[jj] = (j2len[jj - 1] || 0) + 1;
          if (k > bestsize) { besti = i - k + 1; bestj = jj - k + 1; bestsize = k; }
        }
        j2len = nj;
      }
      // extend with equal elements left out of b2j (popular ones); no junk function is used
      while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
      while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
      return [besti, bestj, bestsize];
    }
    var total = 0, queue = [[0, la, 0, lb]];
    while (queue.length) {
      var q = queue.pop(), m = longest(q[0], q[1], q[2], q[3]);
      if (!m[2]) continue;
      total += m[2];
      if (q[0] < m[0] && q[2] < m[1]) queue.push([q[0], m[0], q[2], m[1]]);
      if (m[0] + m[2] < q[1] && m[1] + m[2] < q[3]) queue.push([m[0] + m[2], q[1], m[1] + m[2], q[3]]);
    }
    return 2 * total / (la + lb);
  }

  /** Best fuzzy match of any phrase as [start, end] token indices, or null.
   *  tailOnly > 0 keeps only windows ending within the last tailOnly tokens; accept(window tokens),
   *  when given, must also approve the window (not in Claude Voice, see wakeWindow). */
  function findPhrase(norm, phrases, minRatio, tailOnly, accept) {
    var best = null, n = norm.length;
    (phrases || []).forEach(function (phrase) {
      var p = splitWs(phrase).map(normWord).filter(Boolean), k = p.length;
      if (!k || k > n) return;
      var pj = p.join(' ');
      for (var i = 0; i + k <= n; i++) {
        var end = i + k;
        if (tailOnly && end < n - tailOnly) continue;
        var r = ratio(norm.slice(i, end).join(' '), pj);
        if (r >= minRatio && (!best || r > best[2]) && (!accept || accept(norm.slice(i, end)))) best = [i, end, r];
      }
    });
    return best ? [best[0], best[1]] : null;
  }

  function stripLeadingPunct(t) { return String(t).replace(/^[\s,.;:!?\-]+/, ''); }
  function stripTrailingPunct(t) { return String(t).replace(/[\s,;:\-]+$/, ''); }
  function isUpperWord(w) { return w === w.toUpperCase() && w !== w.toLowerCase(); }
  function isUpperChar(c) { return !!c && c === c.toUpperCase() && c !== c.toLowerCase(); }

  var FILLERS = { um: 1, umm: 1, uh: 1, uhh: 1, uhm: 1, hmm: 1, hm: 1, mm: 1, erm: 1, er: 1, ah: 1, eh: 1, ahh: 1, aa: 1, ii: 1, euh: 1 };
  /** Drop hesitation fillers, ellipses and one-letter fragments from an utterance. */
  function cleanDictation(text) {
    if (!text) return '';
    var parts = String(text).split(/\s*(?:\.\s*){3,}|\s*…/), out = [];
    parts.forEach(function (part) {
      part = (part || '').trim();
      if (!part) return;
      if (out.length && !/[.!?]$/.test(out[out.length - 1])) {
        var first = part.split(/\s+/)[0];
        if (isUpperChar(first.charAt(0)) && !isUpperWord(first) && first !== 'I') part = first.charAt(0).toLowerCase() + first.slice(1) + part.slice(first.length);
      }
      out.push(part);
    });
    var kept = splitWs(out.join(' ')).filter(function (w) { return !FILLERS[w.toLowerCase().replace(NON_WORD, '')]; });
    var t = kept.join(' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,.;:!?\-]+/, '');
    if (t.replace(NON_WORD, '').length <= 1) return '';
    return t;
  }
  /** Lowercase the first word of a piece that continues an unfinished sentence. */
  function continueCase(previous, text) {
    if (!previous || !text || /[.!?\n]\s*$/.test(previous)) return text;
    var first = text.split(/\s+/)[0];
    if (isUpperChar(first.charAt(0)) && !isUpperWord(first) && first !== 'I') return first.charAt(0).toLowerCase() + first.slice(1) + text.slice(first.length);
    return text;
  }

  // ---------- wake / stop / cancel (cfg = /api/voice/status client config) ----------
  function aliased(norm, cfg) { return applyAliases(norm, cfg.wakeAliases || [], cfg.wakeName || 'zam'); }
  // With a short name like "zam" a wake phrase is close to everyday words ("i am" scores 0.8 against
  // "hi zam"), so a wake window must contain the name itself (or a listed misheard form, already
  // mapped to it). Claude Voice's longer "claude" never needed this.
  function wakeWindow(cfg) { var name = cfg.wakeName || 'zam'; return function (win) { return win.indexOf(name) >= 0; }; }
  function stopTail(cfg) { return cfg.stopMustEnd === false ? 0 : 3; }
  function endsWithStop(normAlias, cfg) { return !!findPhrase(normAlias, cfg.stopPhrases || [], 0.8, stopTail(cfg)); }
  function cutStop(orig, normAlias, cfg) {
    var m = findPhrase(normAlias, cfg.stopPhrases || [], 0.8, stopTail(cfg));
    if (!m) return orig.join(' ');
    return stripTrailingPunct(orig.slice(0, m[0]).join(' '));
  }
  /** Wake word in an utterance heard while idle: {rest} (text after the wake phrase) or null. */
  function matchWake(text, cfg) {
    var tk = tokens(text), orig = tk[0], na = aliased(tk[1], cfg);
    var m = findPhrase(na, cfg.wakePhrases || [], cfg.matchRatio || 0.8, 0, wakeWindow(cfg));
    if (!m && cfg.nameAloneAtStart !== false && na.length && na[0] === (cfg.wakeName || 'zam')) m = [0, 1];
    if (!m) return null;
    return { start: m[0], end: m[1], rest: orig.slice(m[1]).join(' ') };
  }
  /** What one utterance means inside a dictation:
   *  {action:'wake'} (the wake phrase repeated), {action:'cancel'}, {action:'send', piece} (ends with a
   *  stop phrase) or {action:'append', piece}. opts.rest = the text after a wake phrase (no wake/cancel check). */
  function dictationStep(text, cfg, opts) {
    var tk = tokens(text), orig = tk[0], norm = tk[1], na = aliased(norm, cfg);
    if (!(opts && opts.rest)) {
      if (norm.length <= 3 && findPhrase(na, cfg.wakePhrases || [], cfg.matchRatio || 0.8, 0, wakeWindow(cfg))) return { action: 'wake' };
      if ((cfg.cancelPhrases || []).length && norm.length <= 4 && findPhrase(na, cfg.cancelPhrases, 0.85)) return { action: 'cancel' };
    }
    if (endsWithStop(na, cfg)) return { action: 'send', piece: cleanDictation(stripLeadingPunct(cutStop(orig, na, cfg))) };
    return { action: 'append', piece: cleanDictation(text) };
  }

  // ---------- audio ----------
  function rms(frame) {
    var n = frame.length; if (!n) return 0;
    var s = 0; for (var i = 0; i < n; i++) s += frame[i] * frame[i];
    return Math.sqrt(s / n);
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  }

  /** Utterance segmentation by level (port of claude_voice/audio.py Microphone._vad_loop), fed with
   *  30 ms frames at 16 kHz. The noise floor comes from the 20th percentile of the first 1.5 s (Claude
   *  Voice takes the median while the app idles; here capture starts when you click, often mid-word)
   *  and those frames are replayed, so speech in the first 1.5 s is kept. opts: mic config plus
   *  noiseFloor (reuse an earlier calibration), onUtterance(Float32Array), onSpeech(). */
  function Segmenter(opts) {
    var o = opts || {};
    this.frameMs = 30;
    this.silenceFrames = Math.floor((o.silenceMs || 900) / this.frameMs);
    this.minSpeechFrames = Math.floor((o.minSpeechMs || 400) / this.frameMs);
    this.maxFrames = Math.floor((o.maxUtteranceS || 30) * 1000 / this.frameMs);
    this.preRollMax = Math.max(1, Math.floor((o.preRollMs || 300) / this.frameMs));
    this.ratio = o.speechRatio || 3.0;
    this.minRms = o.minRms != null ? o.minRms : 0.002;
    this.onUtterance = o.onUtterance || function () {};
    this.onSpeech = o.onSpeech || function () {};
    this.noiseFloor = o.noiseFloor || 0;
    this.calibrating = !this.noiseFloor;
    this.cal = [];
    this.level = 0;
    this.reset();
  }
  Segmenter.prototype.reset = function () { this.inSpeech = false; this.buf = []; this.speechFrames = 0; this.silent = 0; this.preRoll = []; };
  Segmenter.prototype.threshold = function () { return Math.max(this.minRms, this.noiseFloor * this.ratio); };
  Segmenter.prototype.push = function (frame) {
    if (this.calibrating) {
      this.cal.push(frame);
      if (this.cal.length < Math.floor(1500 / this.frameMs)) return;
      this.noiseFloor = percentile(this.cal.map(rms), 0.2) || 1e-4;
      this.calibrating = false;
      var replay = this.cal; this.cal = [];
      for (var i = 0; i < replay.length; i++) this.process(replay[i]);
      return;
    }
    this.process(frame);
  };
  Segmenter.prototype.process = function (frame) {
    var level = rms(frame); this.level = level;
    var isSpeech = level > this.threshold();
    if (!this.inSpeech) {
      if (!isSpeech && level > 0) this.noiseFloor = 0.97 * this.noiseFloor + 0.03 * level;   // track the ambient level
      this.preRoll.push(frame); if (this.preRoll.length > this.preRollMax) this.preRoll.shift();
      if (isSpeech) { this.inSpeech = true; this.buf = this.preRoll.slice(); this.speechFrames = 1; this.silent = 0; this.onSpeech(); }
      return;
    }
    this.buf.push(frame);
    if (isSpeech) { this.speechFrames++; this.silent = 0; } else this.silent++;
    if (this.silent >= this.silenceFrames || this.buf.length >= this.maxFrames) this.emit();
  };
  /** End the current utterance now (push-to-talk released mid-sentence). */
  Segmenter.prototype.flush = function () { if (this.inSpeech) this.emit(); };
  Segmenter.prototype.emit = function () {
    if (this.speechFrames >= this.minSpeechFrames) this.onUtterance(concat(this.buf));
    this.reset();
  };
  function concat(frames) {
    var n = 0; frames.forEach(function (f) { n += f.length; });
    var out = new Float32Array(n), off = 0;
    frames.forEach(function (f) { out.set(f, off); off += f.length; });
    return out;
  }

  /** Float samples (-1..1) to a 16-bit PCM mono WAV (ArrayBuffer). */
  function encodeWav(samples, sampleRate) {
    var sr = sampleRate || 16000, n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return buf;
  }

  var api = {
    normWord: normWord, tokens: tokens, applyAliases: applyAliases, ratio: ratio, findPhrase: findPhrase,
    stripLeadingPunct: stripLeadingPunct, stripTrailingPunct: stripTrailingPunct,
    cleanDictation: cleanDictation, continueCase: continueCase,
    endsWithStop: endsWithStop, cutStop: cutStop, matchWake: matchWake, dictationStep: dictationStep,
    rms: rms, Segmenter: Segmenter, encodeWav: encodeWav
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZxVoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
