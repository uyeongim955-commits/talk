/**
 * 단톡방 SVG Worker · 620x400 (가로형)
 * 카카오톡/라인/인스타 DM 참고. 단일 컬럼 대화.
 * 크랙 표시 상한(높이 약 230 CSS px)에 맞춰 낮고 넓게 잡음 — 세로를 키우면 글자가 작아진다.
 *
 * 파라미터
 * - r: 방 이름
 * - d: 날짜 구분선 문구
 * - t: 시작 시각 HH:MM (발화 묶음마다 1분씩 진행)
 * - p: 상단 고정 공지 1줄 (생략 가능)
 * - m: 멤버 "이름", ; 구분 (최대 7). 인원수 표시용. 생략 시 발신자에서 자동
 * - l: 메시지, ; 구분 (최대 16)
 *      발화  : 닉~내용  또는 닉~내용~안읽음수
 *      시스템: !내용    (가운데 회색 칩)
 *      ※ 유저 말풍선 없음. 전부 ⓒ 발화만.
 * - x=1: 인물 이미지 진단 (텍스트 출력)
 *
 * 같은 사람이 연달아 말하면 프로필·이름은 첫 줄에만, 시각은 마지막 줄에만.
 * 공백은 + 로 표기. 퍼센트 인코딩 불필요.
 *
 * 주의: 대화 내용이 URL 에 실려 Cloudflare 네트워크를 경유함.
 * 배포 후 Worker Settings > Observability 에서 Workers Logs 를 반드시 비활성화할 것.
 *
 * 방어 · 프챗급 방탄
 * - 어떤 GET에도 400을 내지 않음: 미지 키·중복 키 무시, 전각 기호·&amp; 자동 교정,
 *   초과 길이 절단, 닉 없는 발화는 직전 발화자 이어받기, 닉:내용 형식도 수용.
 * - 모든 텍스트의 XML 특수문자는 이스케이프.
 * - 이미지는 고정 호스트의 [주연 14명]01.webp 만. 임의 URL 불가.
 */

const W = 620;
const H = 400;

const BG = "#f2f4f8";        // 대화 배경
const OTHER = "#ffffff";     // 말풍선
const BORDER = "#e4e8ef";    // 말풍선 테두리
const ACCENT = "#5b7cfa";    // 안읽음·포인트 인디고
const SEND = "#5b7cfa";      // 보내기 버튼

const HEAD_B = 42;           // 헤더 바닥
const NOTICE_H = 28;         // 공지 바 높이
const INPUT_H = 28;          // 입력바 높이
const AV_X = 12;             // 프로필 x
const BUB_L = 54;            // 말풍선 시작 x
const MAXB = 470;            // 말풍선 최대 폭
const FS = 17;               // 메시지 글자 크기
const LH = 22;               // 줄 높이

const AVATARS = ["#6b8fd4", "#e0855a", "#4fa189", "#c76b9a", "#7a6bc7", "#d0a13c", "#4f9bb5", "#a8724f"];

// 주연 14명 고정 프로필색 — 초상을 못 받았을 때도 인물이 구분되게
const CHARS = {
  "강도현": "#c85a22", "한혜원": "#8c2f39", "정태양": "#c08810", "윤아린": "#2f6b8c",
  "박연아": "#6f9e4f", "이준": "#465a78", "문가인": "#8a4fa8",
  "레바딘": "#2f7f9e", "카에돈": "#b8371f", "녹스": "#2e5c46", "필리아": "#d1452e",
  "프시케": "#3f9fb5", "리비안": "#4a4560", "이그니펠": "#d97b1f",
};
// 성 없이 불러도 풀네임으로 정규화 (URL 단축 + 표기 통일)
const ALIAS = {
  "도현": "강도현", "혜원": "한혜원", "해원": "한혜원", "태양": "정태양",
  "아린": "윤아린", "연아": "박연아", "가인": "문가인",
};
const fullName = (n) => ALIAS[n] || n;
const avatarColor = (n) => CHARS[n] || AVATARS[hash(n) % AVATARS.length];

// 인물 기본이미지(01). SVG 는 <img> 로 로드되면 외부 이미지를 못 받으므로
// 워커가 직접 받아 base64 로 심는다. 호스트·파일명 모두 고정 — 임의 URL 금지.
const IMG_HOST = "https://5aaa.uk/";
const PORTRAIT = new Set([
  "강도현", "한혜원", "정태양", "윤아린", "박연아", "이준", "문가인",
  "레바딘", "카에돈", "녹스", "필리아", "프시케", "리비안", "이그니펠",
]);
const MAX_PICS = 8;
const MAX_ONE = 60 * 1024;
const MAX_ALL = 300 * 1024;

// 원본은 한 장에 300~430KB라 그대로 심으면 SVG 가 수 MB 가 된다.
// 무료 리사이즈 프록시로 96px 썸네일만 받아 base64 로 심는다.
const THUMB_PX = 128;
const PROXY = ["https://wsrv.nl/?url=", "https://images.weserv.nl/?url="];
const thumbUrl = (name, code = "01", px = THUMB_PX, p = 0) =>
  `${PROXY[p] || PROXY[0]}${IMG_HOST.replace(/^https?:\/\//, "")}${encodeURIComponent(name)}${code}.webp` +
  `&w=${px}&h=${px}&fit=cover&a=top&output=webp&q=82`;

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// 이름 목록에 대응하는 01 이미지를 받아 data URI 로 반환. 실패분은 그냥 빠진다.
const PIC_TIMEOUT = 4500;

async function loadPortraits(names) {
  const uniq = [...new Set(names)].filter((n) => PORTRAIT.has(n)).slice(0, MAX_PICS);
  const pics = new Map();
  if (!uniq.length) return pics;

  // 느린 이미지 한 장이 전체 응답을 잡아먹지 않도록 제한시간을 둔다.
  // 시간 안에 못 받은 인물은 실루엣으로 내려간다.
  const late = new Promise((res) => setTimeout(() => res(null), PIC_TIMEOUT));
  const one = async (n, code = "01", px = THUMB_PX) => {
    // 프록시 한쪽이 실패하면 다른 도메인으로 한 번 더
    for (let p = 0; p < PROXY.length; p += 1) {
      try {
        const res = await fetch(thumbUrl(n, code, px, p), {
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });
        if (!res.ok) continue;
        const type = (res.headers.get("content-type") || "image/webp").split(";")[0].trim();
        if (!/^image\//.test(type)) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX_ONE) continue;
        return [n, buf, type];
      } catch (e) { /* 다음 프록시 */ }
    }
    return null;
  };
  const got = await Promise.all(uniq.map((n) => Promise.race([one(n), late])));

  let total = 0;
  for (const g of got) {
    if (!g || total + g[1].length > MAX_ALL) continue;
    total += g[1].length;
    pics.set(g[0], `data:${g[2]};base64,${toBase64(g[1])}`);
  }

  return pics;
}

function esc(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function charWidth(ch, size) {
  const c = ch.codePointAt(0);
  if (c >= 0x1100 && c <= 0x11ff) return size;
  if (c >= 0x3130 && c <= 0x318f) return size;
  if (c >= 0xac00 && c <= 0xd7a3) return size;
  if (c >= 0x4e00 && c <= 0x9fff) return size;
  if (c >= 0x3000 && c <= 0x303f) return size;
  if (c >= 0x1f300 && c <= 0x1faff) return size * 1.15;
  if (c >= 0x2600 && c <= 0x27bf) return size;
  if (ch === " ") return size * 0.28;
  if (/[A-Z]/.test(ch)) return size * 0.63;
  if (/[iIljt.,;:'!|]/.test(ch)) return size * 0.3;
  return size * 0.52;
}

function measure(text, size) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size);
  return w;
}

function clip(text, size, maxWidth) {
  if (measure(text, size) <= maxWidth) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch, size);
    if (w + cw > maxWidth - size) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function wrapText(text, size, maxWidth, maxLines) {
  const lines = [];
  let line = "";
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch, size);
    if (width + w > maxWidth && line) {
      lines.push(line);
      if (lines.length >= maxLines) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/.$/, "…");
        return lines;
      }
      line = ch === " " ? "" : ch;
      width = ch === " " ? 0 : w;
    } else {
      line += ch;
      width += w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function hash(seed) {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function addTime(base, minutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(base);
  if (!m) return "";
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  const ampm = hh < 12 ? "오전" : "오후";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${ampm} ${h12}:${String(mm).padStart(2, "0")}`;
}

// 전각 기호를 반각으로 (프챗급 모델이 섞어 쓰는 ；～：！＋ 등)
const FW_MAP = { "；": ";", "｜": "|", "～": "~", "：": ":", "！": "!", "？": "?", "＊": "*", "＋": " ", "　": " ", "＆": "&", "＝": "=" };
function fwNorm(s) {
  return s.replace(/[；｜～：！？＊＋　＆＝０-９]/g, (c) => FW_MAP[c] ?? String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 프챗급 방탄 — 절대 400을 내지 않는다.
// 경로 무관 · 미지 키 무시 · 중복 키는 첫 유효값 · 구조 깨진 전각 ＆＝·&amp;는 교정 · 초과 길이는 절단.
function lenientParams(search, cap) {
  let raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length > cap) raw = raw.slice(0, cap);
  raw = raw
    .replace(/&(amp;)+/gi, "&")
    .replace(/%EF%BC%86/gi, "&").replace(/[＆]/g, "&")
    .replace(/%EF%BC%9D/gi, "=").replace(/[＝]/g, "=");
  let sp;
  try { sp = new URLSearchParams(raw); } catch (e) { sp = new URLSearchParams(); }
  const first = new Map();
  for (const [rk, rv] of sp) {
    const key = rk.trim().toLowerCase();
    if (!first.has(key) || first.get(key) === "") first.set(key, String(rv));
  }
  return first;
}

function parseInput(url) {
  const first = lenientParams(url.search, 6000);
  const get = (key) => fwNorm(first.get(key) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();

  const room = get("r").slice(0, 20) || "단톡방";
  const day = get("d").slice(0, 26);
  const base = /^\d{1,2}:\d{2}$/.test(get("t")) ? get("t") : "20:10";
  const notice = get("p").slice(0, 44);

  // 모델이 "닉;내용" 처럼 ~ 대신 ; 를 쓴 경우 되붙인다
  const rawRows = get("l").split(/[;|]/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < rawRows.length; i += 1) {
    const cur = rawRows[i];
    const bare = cur.replace(/^[!>]+/, "").trim();
    const next = rawRows[i + 1];
    if (!cur.includes("~") && CHARS[fullName(bare)] && next && !next.includes("~")) {
      rows.push(`${bare}~${next}`);
      i += 1;
    } else {
      rows.push(cur);
    }
  }

  let lastNick = "";
  const msgs = rows.slice(0, 16).map((row) => {
    let r = row;
    let kind = "other";
    if (r.startsWith("!")) { kind = "sys"; r = r.slice(1).trim(); }
    r = r.replace(/^>+/, "").trim();   // 유저 말풍선은 두지 않는다

    let unread = "";
    const u = r.lastIndexOf("~");
    if (u > 0 && /^\d{1,2}$/.test(r.slice(u + 1).trim())) {
      unread = r.slice(u + 1).trim();
      r = r.slice(0, u).trim();
    }

    if (kind === "sys") return { kind, nick: "", text: r.slice(0, 60), unread: "" };

    let k = r.indexOf("~");
    if (k === -1) {
      // "닉: 내용" 폴백 — 왼쪽이 주연 이름일 때만
      const c = r.indexOf(":");
      if (c > 0 && c <= 8 && CHARS[fullName(r.slice(0, c).trim())]) k = c;
    }
    let nick = k === -1 ? "" : r.slice(0, k).trim();
    let text = k === -1 ? r : r.slice(k + 1).trim();
    if (!text) { text = nick; nick = ""; }
    if (nick.length > 12) { text = nick + (text ? " " + text : ""); nick = ""; }
    // 닉이 빠진 발화는 직전 발화자가 이어 말한 것으로
    const finalNick = fullName((nick || lastNick || "익명").slice(0, 12));
    lastNick = finalNick;
    return { kind, nick: finalNick, text: text.slice(0, 180), unread };
  }).filter((m) => m.text);
  if (!msgs.length) msgs.push({ kind: "sys", nick: "", text: "메시지 수신 대기 중", unread: "" });

  let members = get("m").split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 7).map((row) => {
    const k = row.indexOf("~");
    return {
      name: fullName((k === -1 ? row : row.slice(0, k)).trim().slice(0, 12)) || "익명",
      note: (k === -1 ? "" : row.slice(k + 1)).trim().slice(0, 20),
    };
  });
  if (!members.length) {
    const uniq = [];
    for (const m of msgs) if (m.kind === "other" && !uniq.includes(m.nick)) uniq.push(m.nick);
    members = uniq.slice(0, 7).map((name) => ({ name, note: "" }));
  }

  return { room, day, base, notice, msgs, members };
}

// 색을 흰색과 섞어 옅은 배경 톤을 만든다
function mix(hex, w) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (255 - v) * w);
  const out = (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255);
  return "#" + (out | 0x1000000).toString(16).slice(1);
}

// ?x=1 진단: 14명 01 이미지의 상태·용량을 텍스트로 보고
async function diagnose() {
  const names = [...PORTRAIT];
  const probe = async (url) => {
    try {
      const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
      const type = (res.headers.get("content-type") || "-").split(";")[0].trim();
      if (!res.ok) return { line: `HTTP ${res.status}`, size: 0, type };
      const buf = new Uint8Array(await res.arrayBuffer());
      return { line: `${(buf.length / 1024).toFixed(1)}KB`, size: buf.length, type };
    } catch (e) {
      return { line: `실패(${String(e).slice(0, 30)})`, size: 0, type: "-" };
    }
  };
  const rows = await Promise.all(names.map(async (n) => {
    const [raw, t0, t1] = await Promise.all([
      probe(`${IMG_HOST}${encodeURIComponent(n)}01.webp`),
      probe(thumbUrl(n, "01", THUMB_PX, 0)),
      probe(thumbUrl(n, "01", THUMB_PX, 1)),
    ]);
    const good = (t) => t.size > 0 && t.size <= MAX_ONE && /^image\//.test(t.type);
    const ok = good(t0) ? "OK(프록시1)" : good(t1) ? "OK(프록시2)" : "제외";
    return `${n}\t원본 ${raw.line}\t프록시1 ${t0.line}\t프록시2 ${t1.line}\t${ok}`;
  }));
  return [
    "== 인물 01 이미지 진단 ==",
    `호스트 ${IMG_HOST}`,
    `썸네일 ${THUMB_PX}px · 한 장 상한 ${(MAX_ONE / 1024).toFixed(0)}KB · 합계 ${(MAX_ALL / 1024).toFixed(0)}KB · 최대 ${MAX_PICS}명 · 제한시간 ${PIC_TIMEOUT}ms`,
    `Buffer(nodejs_compat) ${typeof Buffer !== "undefined" ? "있음" : "없음"}`,
    "",
    ...rows,
  ].join("\n");
}

// 프로필. 인물 01 이미지가 실리면 사진, 아니면 색 구분 실루엣
// 모서리별 반경이 다른 말풍선 패스. head 풍선만 좌상단을 살짝 각지게
function bubblePath(x, y, w, h, head) {
  const r = 14;
  const tl = head ? 5 : r;
  return `M${x + tl} ${y} h${w - tl - r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r * 2} a${r} ${r} 0 0 1 -${r} ${r} h${-(w - r * 2)} a${r} ${r} 0 0 1 -${r} -${r} v${-(h - tl - r)} a${tl} ${tl} 0 0 1 ${tl} -${tl} Z`;
}

// 프로필. 인물 01 썸네일이 실리면 원형 사진, 아니면 색 구분 실루엣
function avatar(x, y, s, name, pics) {
  if (pics && pics.has(name)) {
    const id = `p${hash(name).toString(36)}`;
    return `<use href="#${id}" xlink:href="#${id}" x="${x}" y="${y}" width="${s}" height="${s}"/>`;
  }
  const c = avatarColor(name);
  const ini = [...String(name || "?")][0] || "?";
  return `<circle cx="${x + s / 2}" cy="${y + s / 2}" r="${s / 2}" fill="${mix(c, 0.8)}"/>
  <text x="${x + s / 2}" y="${(y + s * 0.685).toFixed(1)}" text-anchor="middle" font-size="${(s * 0.46).toFixed(1)}" font-weight="700" fill="${c}" letter-spacing="-0.5">${esc(ini)}</text>`;
}

// 같은 인물이 여러 번 나와도 이미지는 defs 에 한 번만 심는다
function portraitDefs(pics) {
  const syms = [...pics.entries()].map(([n, src]) => {
    const id = `p${hash(n).toString(36)}`;
    return `<symbol id="${id}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin slice">
      <clipPath id="${id}c"><circle cx="50" cy="50" r="50"/></clipPath>
      <image href="${src}" xlink:href="${src}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMin slice" clip-path="url(#${id}c)"/>
    </symbol>`;
  }).join("");
  return `<defs>
    <filter id="bsh" x="-8%" y="-12%" width="116%" height="132%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#1b2a4a" flood-opacity="0.07"/>
    </filter>
    ${syms}</defs>`;
}

function chatSvg({ room, day, base, notice, msgs, members }, pics) {
  const total = members.length;

  // 같은 사람 연속 발화 묶기
  const items = msgs.map((m, i) => {
    const prev = msgs[i - 1];
    const head = !prev || prev.kind !== m.kind || prev.nick !== m.nick || m.kind === "sys";
    return { ...m, head };
  });
  items.forEach((m, i) => {
    const next = items[i + 1];
    m.tail = !next || next.kind !== m.kind || next.nick !== m.nick || m.kind === "sys";
  });

  // 발화 묶음마다 1분씩 진행
  let g = -1;
  items.forEach((m) => {
    if (m.head) g += 1;
    m.time = m.kind === "sys" ? "" : addTime(base, g);
  });

  const chatTop = (notice ? HEAD_B + NOTICE_H : HEAD_B) + 5;
  const chatBottom = H - INPUT_H - 4;

  const NAME_H = 15;
  const PAD = 10;
  const avail = chatBottom - chatTop;

  // 모델이 말을 많이 넣어도 버리지 않는다 — 먼저 글자를 줄여 전부 담아보고,
  // 최소 크기로도 안 되면 그때만 오래된 것부터 밀어낸다.
  const SCALES = [1, 0.94, 0.88, 0.82, 0.76, 0.7];
  const build = (scale) => {
    const fs = Math.round(FS * scale * 2) / 2;
    const lh = Math.round(LH * scale * 2) / 2;
    const maxLines = scale < 0.85 ? 4 : 3;
    const rows = [];
    let showDay = !!day;
    let hSum = showDay ? 30 : 0;
    for (const src of items) {
      const m = { ...src };
      if (m.kind === "sys") {
        m.h = 28;
        rows.push(m);
        hSum += 28;
        continue;
      }
      m.lines = wrapText(m.text, fs, MAXB - 28, maxLines);
      m.bw = Math.min(MAXB, Math.round(Math.max(...m.lines.map((l) => measure(l, fs)))) + 28);
      m.bh = m.lines.length * lh + PAD;
      m.h = (m.head ? NAME_H : 0) + m.bh + (m.tail ? 6 : 3);
      rows.push(m);
      hSum += m.h;
    }
    if (hSum > avail && showDay) { showDay = false; hSum -= 30; }
    return { rows, hSum, showDay, fs, lh };
  };

  let fit = build(1);
  for (const s of SCALES) {
    fit = build(s);
    if (fit.hSum <= avail) break;
  }

  const { fs, lh } = fit;
  let showDay = fit.showDay;
  const laid = fit.rows;
  let hSum = fit.hSum;
  while (laid.length > 1 && hSum > avail) {
    hSum -= laid.shift().h;
    if (laid.length && laid[0].kind !== "sys" && !laid[0].head) {
      laid[0].head = true;
      laid[0].h += NAME_H;
      hSum += NAME_H;
    }
  }

  let y = chatTop;
  const CX = W / 2;

  let out = "";
  if (showDay) {
    const dw = Math.round(measure(day, 11)) + 24;
    out += `<rect x="${CX - dw / 2}" y="${y}" width="${dw}" height="22" rx="11" fill="#ffffff" stroke="${BORDER}"/>
    <text x="${CX}" y="${y + 15}" text-anchor="middle" class="day">${esc(day)}</text>`;
    y += 30;
  }

  for (const m of laid) {
    if (m.kind === "sys") {
      const sw = Math.round(measure(m.text, 11)) + 24;
      out += `<rect x="${CX - sw / 2}" y="${y}" width="${sw}" height="22" rx="11" fill="#ffffff" stroke="${BORDER}"/>
      <text x="${CX}" y="${y + 15}" text-anchor="middle" class="sys">${esc(m.text)}</text>`;
      y += m.h;
      continue;
    }

    let by = y;
    if (m.head) {
      out += `${avatar(AV_X, y, 34, m.nick, pics)}
      <text x="${BUB_L}" y="${y + 10}" class="mn">${esc(clip(m.nick, 11.5, 240))}</text>`;
      by = y + NAME_H;
    }

    out += `<path d="${bubblePath(BUB_L, by, m.bw, m.bh, m.head)}" fill="${OTHER}" stroke="${BORDER}" stroke-width="1" filter="url(#bsh)"/>`;
    out += m.lines.map((ln, i) =>
      `<text x="${BUB_L + 14}" y="${(by + PAD / 2 + fs * 0.94 + i * lh).toFixed(1)}" class="msg">${esc(ln)}</text>`).join("");

    if (m.tail || m.unread) {
      const stampY = by + m.bh - 4;
      const stampW = (m.unread ? measure(m.unread, 10) + 4 : 0) + (m.tail ? measure(m.time, 10) : 0);
      let sx = Math.min(BUB_L + m.bw + 6, W - 8 - stampW);
      if (m.unread) {
        out += `<text x="${sx}" y="${stampY}" class="unread">${esc(m.unread)}</text>`;
        sx += Math.round(measure(m.unread, 10)) + 4;
      }
      if (m.tail) out += `<text x="${sx}" y="${stampY}" class="time">${m.time}</text>`;
    }
    y += m.h;
  }

  const roomLabel = clip(room, 15, W - 210);
  const nameW = Math.round(measure(roomLabel, 15));

  return `<?xml version="1.0" encoding="UTF-8"?><!--R3-->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="단톡방 ${esc(room)}">
  <style>
    text { font-family: Pretendard, -apple-system, "SamsungOne", "Samsung Sans", system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    .htitle { font-size: 15px; font-weight: 700; fill: #101828; letter-spacing: -.5px; }
    .hcount { font-size: 11px; font-weight: 700; fill: ${ACCENT}; letter-spacing: 0; }
    .notice { font-size: 11px; font-weight: 600; fill: #4a5578; letter-spacing: -.3px; }
    .day { font-size: 11px; font-weight: 600; fill: #7b8694; letter-spacing: -.2px; }
    .sys { font-size: 11px; font-weight: 500; fill: #7b8694; letter-spacing: -.2px; }
    .mn { font-size: 11.5px; font-weight: 600; fill: #667085; letter-spacing: -.35px; }
    .msg { font-size: ${fs}px; font-weight: 450; fill: #1c1e21; letter-spacing: -.45px; }
    .time { font-size: 10px; font-weight: 500; fill: #9aa3ae; letter-spacing: -.1px; }
    .unread { font-size: 10px; font-weight: 700; fill: ${ACCENT}; letter-spacing: 0; }
    .ph { font-size: 11px; font-weight: 450; fill: #9aa4b0; letter-spacing: -.3px; }
  </style>
  ${portraitDefs(pics)}

  <rect width="${W}" height="${H}" fill="${BG}"/>

  <rect x="0" y="0" width="${W}" height="${HEAD_B}" fill="#ffffff"/>
  <line x1="0" y1="${HEAD_B}" x2="${W}" y2="${HEAD_B}" stroke="#e7eaf0"/>
  <path d="M19 14 L12 21 L19 28" fill="none" stroke="#344054" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  ${avatar(28, 8, 26, room, pics)}
  <text x="62" y="26" class="htitle">${esc(roomLabel)}</text>
  <rect x="${68 + nameW}" y="12" width="${17 + String(total).length * 6}" height="17" rx="8.5" fill="#eef1fe"/>
  <text x="${76 + nameW + String(total).length * 3}" y="24" text-anchor="middle" class="hcount">${total}</text>
  <circle cx="${W - 40}" cy="21" r="1.9" fill="#98a2b3"/>
  <circle cx="${W - 31}" cy="21" r="1.9" fill="#98a2b3"/>
  <circle cx="${W - 22}" cy="21" r="1.9" fill="#98a2b3"/>

  ${notice ? `<rect x="0" y="${HEAD_B}" width="${W}" height="${NOTICE_H}" fill="#f4f6fe"/>
  <line x1="0" y1="${HEAD_B + NOTICE_H}" x2="${W}" y2="${HEAD_B + NOTICE_H}" stroke="#e2e8fb"/>
  <path d="M16 ${HEAD_B + 8} h11 v8 l-5.5 6 l-5.5 -6 Z" fill="${ACCENT}"/>
  <text x="36" y="${HEAD_B + 19}" class="notice">${esc(clip(notice, 11, W - 54))}</text>` : ""}

  ${out}

  <rect x="0" y="${H - INPUT_H}" width="${W}" height="${INPUT_H}" fill="#ffffff"/>
  <line x1="0" y1="${H - INPUT_H}" x2="${W}" y2="${H - INPUT_H}" stroke="#e7eaf0"/>
  <line x1="14" y1="${H - 14}" x2="26" y2="${H - 14}" stroke="#98a2b3" stroke-width="1.8" stroke-linecap="round"/>
  <line x1="20" y1="${H - 20}" x2="20" y2="${H - 8}" stroke="#98a2b3" stroke-width="1.8" stroke-linecap="round"/>
  <rect x="36" y="${H - 22}" width="${W - 78}" height="16" rx="8" fill="#f2f4f8"/>
  <text x="48" y="${H - 10}" class="ph">메시지 입력</text>
  <circle cx="${W - 20}" cy="${H - 14}" r="10" fill="${SEND}"/>
  <path d="M${W - 26} ${H - 19} L${W - 14} ${H - 14} L${W - 26} ${H - 9} L${W - 23.5} ${H - 14} Z" fill="#ffffff"/>
</svg>`;
}

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()",
    "X-Content-Type-Options": "nosniff",
  };
}

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { ...responseHeaders("text/plain; charset=utf-8"), Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);

    if (url.searchParams.get("x") === "1") {
      return new Response(request.method === "HEAD" ? null : await diagnose(), {
        status: 200,
        headers: { ...responseHeaders("text/plain; charset=utf-8"), "Cache-Control": "no-store" },
      });
    }

    const data = parseInput(url);

    // ?x=2 : 같은 파라미터를 워커가 어떻게 읽었는지 텍스트로 보고
    if (data && url.searchParams.get("x") === "2") {
      const wantedD = [...data.msgs.map((m) => m.nick), ...data.members.map((m) => m.name)];
      const picsD = await loadPortraits(wantedD);
      const svgD = chatSvg(data, picsD);
      const lines = [
        "== 입력 해석 결과 ==",
        `방 ${data.room} · 멤버 ${data.members.map((m) => m.name).join(", ") || "(없음)"}`,
        `기준시각 ${data.base} · 날짜 ${data.day || "(없음)"} · 공지 ${data.notice || "(없음)"}`,
        `메시지 ${data.msgs.length}개 · SVG ${(svgD.length / 1024).toFixed(0)}KB`,
        "",
        "번호  발신자        초상   내용",
        ...data.msgs.map((m, i) => {
          const who = m.kind === "sys" ? "(시스템)" : m.nick;
          const pic = m.kind === "sys" ? "-" : (picsD.has(m.nick) ? "있음" : "없음");
          return `${String(i + 1).padStart(2)}   ${who.padEnd(12)} ${pic.padEnd(5)} ${m.text}`;
        }),
        "",
        "발신자가 익명이면 닉이 안 붙은 것 — l 은 닉~내용 형식이어야 함",
        "초상 없음이면 그 이름이 주연 14명에 없는 것",
      ];
      return new Response(request.method === "HEAD" ? null : lines.join("\n"), {
        status: 200,
        headers: { ...responseHeaders("text/plain; charset=utf-8"), "Cache-Control": "no-store" },
      });
    }

    const noPics = url.searchParams.get("i") === "0";
    const wanted = [...data.msgs.map((m) => m.nick), ...data.members.map((m) => m.name)];
    const pics = request.method === "HEAD" || noPics ? new Map() : await loadPortraits(wanted);

    return new Response(request.method === "HEAD" ? null : chatSvg(data, pics), {
      status: 200,
      headers: responseHeaders("image/svg+xml; charset=utf-8"),
    });
  },
};
