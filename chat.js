/**
 * 단톡방 SVG Worker · 640x860 (세로형)
 * 카카오톡/라인/인스타 DM 참고. 상단 참여자 띠 + 단일 컬럼 대화.
 *
 * 파라미터
 * - r: 방 이름
 * - d: 날짜 구분선 문구
 * - t: 시작 시각 HH:MM (발화 묶음마다 1분씩 진행)
 * - p: 상단 고정 공지 1줄 (생략 가능)
 * - m: 멤버 "이름", ; 구분 (최대 7). 생략 시 발신자에서 자동 추출
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
 * 방어
 * - 허용 파라미터 외 키·중복 키·3000자 초과 쿼리는 400.
 * - 모든 텍스트의 XML 특수문자는 이스케이프.
 * - 이미지는 고정 호스트의 [주연 14명]01.webp 만. 임의 URL 불가.
 */

const W = 640;
const H = 860;

const BG = "#93a8c4";        // 대화 배경
const MINE = "#ffe6a3";      // 보내기 버튼 강조
const OTHER = "#ffffff";     // 말풍선
const ACCENT = "#e8654a";    // 안읽음 표시

const STRIP_B = 116;         // 헤더 + 참여자 띠 바닥
const AV_STEP = 56;          // 참여자 띠 간격
const AV_X = 22;             // 대화 프로필 x
const BUB_L = 66;            // 말풍선 시작 x
const MAXB = 462;            // 말풍선 최대 폭
const FS = 16.5;             // 메시지 글자 크기
const LH = 23;               // 줄 높이

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
const MAX_PICS = 6;
const MAX_ONE = 60 * 1024;
const MAX_ALL = 300 * 1024;

// 원본은 한 장에 300~430KB라 그대로 심으면 SVG 가 수 MB 가 된다.
// 무료 리사이즈 프록시로 96px 썸네일만 받아 base64 로 심는다.
const thumbUrl = (name) =>
  `https://wsrv.nl/?url=${IMG_HOST.replace(/^https?:\/\//, "")}${encodeURIComponent(name)}01.webp` +
  `&w=96&h=96&fit=cover&a=top&output=webp&q=82`;

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// 이름 목록에 대응하는 01 이미지를 받아 data URI 로 반환. 실패분은 그냥 빠진다.
async function loadPortraits(names) {
  const uniq = [...new Set(names)].filter((n) => PORTRAIT.has(n)).slice(0, MAX_PICS);
  const pics = new Map();
  if (!uniq.length) return pics;

  const got = await Promise.all(uniq.map(async (n) => {
    try {
      const res = await fetch(thumbUrl(n), {
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      if (!res.ok) return null;
      const type = (res.headers.get("content-type") || "image/webp").split(";")[0].trim();
      if (!/^image\//.test(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_ONE) return null;
      return [n, buf, type];
    } catch (e) {
      return null;
    }
  }));

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

function parseInput(url) {
  if (url.search.length > 3000) return null;
  const allowed = new Set(["r", "d", "t", "p", "m", "l", "x"]);
  const seen = new Set();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const get = (key) => (url.searchParams.get(key) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();

  const room = get("r").slice(0, 20) || "단톡방";
  const day = get("d").slice(0, 26);
  const base = /^\d{1,2}:\d{2}$/.test(get("t")) ? get("t") : "20:10";
  const notice = get("p").slice(0, 44);

  const msgs = get("l").split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 16).map((row) => {
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

    const k = r.indexOf("~");
    let nick = k === -1 ? "" : r.slice(0, k).trim();
    let text = k === -1 ? r : r.slice(k + 1).trim();
    if (!text) { text = nick; nick = ""; }
    if (nick.length > 12) { text = nick + (text ? " " + text : ""); nick = ""; }
    return { kind, nick: fullName((nick || "익명").slice(0, 12)), text: text.slice(0, 120), unread };
  }).filter((m) => m.text);

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
    const [raw, thumb] = await Promise.all([
      probe(`${IMG_HOST}${encodeURIComponent(n)}01.webp`),
      probe(thumbUrl(n)),
    ]);
    const ok = thumb.size > 0 && thumb.size <= MAX_ONE && /^image\//.test(thumb.type) ? "OK" : "제외";
    return `${n}\t원본 ${raw.line}\t썸네일 ${thumb.line} ${thumb.type}\t${ok}`;
  }));
  return [
    "== 인물 01 이미지 진단 ==",
    `호스트 ${IMG_HOST}`,
    `썸네일 96px · 한 장 상한 ${(MAX_ONE / 1024).toFixed(0)}KB · 합계 ${(MAX_ALL / 1024).toFixed(0)}KB · 최대 ${MAX_PICS}명`,
    `Buffer(nodejs_compat) ${typeof Buffer !== "undefined" ? "있음" : "없음"}`,
    "",
    ...rows,
  ].join("\n");
}

// 프로필. 인물 01 이미지가 실리면 사진, 아니면 색 구분 실루엣
// 프로필. 인물 01 썸네일이 실리면 사진, 아니면 색 구분 실루엣
// 구형 안드로이드 WebView 대응으로 href 와 xlink:href 를 함께 준다
function avatar(x, y, s, name, pics) {
  if (pics && pics.has(name)) {
    const id = `p${hash(name).toString(36)}`;
    return `<use href="#${id}" xlink:href="#${id}" x="${x}" y="${y}" width="${s}" height="${s}" clip-path="url(#rnd)"/>`;
  }
  const c = avatarColor(name);
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.34}" fill="${mix(c, 0.8)}"/>
  <circle cx="${x + s / 2}" cy="${y + s * 0.37}" r="${s * 0.165}" fill="${c}"/>
  <path d="M${x + s * 0.21} ${y + s * 0.87} a${s * 0.29} ${s * 0.27} 0 0 1 ${s * 0.58} 0 Z" fill="${c}"/>`;
}

// 같은 인물이 여러 번 나와도 이미지는 defs 에 한 번만 심는다
function portraitDefs(pics) {
  const syms = [...pics.entries()].map(([n, src]) =>
    `<symbol id="p${hash(n).toString(36)}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin slice">
      <image href="${src}" xlink:href="${src}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMin slice"/>
    </symbol>`).join("");
  return `<defs>
    <clipPath id="rnd" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.34" ry="0.34"/></clipPath>
    ${syms}
  </defs>`;
}

// 상단 참여자 띠 (프로필 + 이름)
function memberStrip(members, pics) {
  const n = Math.min(members.length, 7);
  const step = Math.min(AV_STEP, Math.floor((W - 40) / Math.max(n, 1)));
  return members.slice(0, n).map((m, i) => {
    const x = 22 + i * step;
    return `${avatar(x, 66, 32, m.name, pics)}
    <text x="${x + 16}" y="${STRIP_B - 8}" text-anchor="middle" class="sname">${esc(clip(m.name, 11, step - 2))}</text>`;
  }).join("");
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

  const chatTop = (notice ? STRIP_B + 38 : STRIP_B) + 12;
  const chatBottom = H - 82;

  // 높이 계산 후 아래에서부터 채운다
  const laid = [];
  let hSum = day ? 40 : 0;
  for (const m of items) {
    if (m.kind === "sys") {
      m.h = 38;
      laid.push(m);
      hSum += 38;
      continue;
    }
    m.lines = wrapText(m.text, FS, MAXB - 30, 4);
    m.bw = Math.min(MAXB, Math.round(Math.max(...m.lines.map((l) => measure(l, FS)))) + 30);
    m.bh = m.lines.length * LH + 16;
    m.h = (m.head ? 18 : 0) + m.bh + (m.tail ? 9 : 4);
    laid.push(m);
    hSum += m.h;
  }

  let y = Math.max(chatTop, chatBottom - hSum);
  const CX = W / 2;

  let out = "";
  if (day) {
    const dw = Math.round(measure(day, 12.5)) + 30;
    out += `<rect x="${CX - dw / 2}" y="${y + 3}" width="${dw}" height="26" rx="13" fill="#000000" opacity=".16"/>
    <text x="${CX}" y="${y + 21}" text-anchor="middle" class="day">${esc(day)}</text>`;
    y += 40;
  }

  for (const m of laid) {
    if (m.kind === "sys") {
      const sw = Math.round(measure(m.text, 12.5)) + 30;
      out += `<rect x="${CX - sw / 2}" y="${y + 2}" width="${sw}" height="26" rx="13" fill="#000000" opacity=".13"/>
      <text x="${CX}" y="${y + 20}" text-anchor="middle" class="sys">${esc(m.text)}</text>`;
      y += m.h;
      continue;
    }

    let by = y;
    if (m.head) {
      out += `${avatar(AV_X, y, 34, m.nick, pics)}
      <text x="${BUB_L}" y="${y + 11}" class="mn">${esc(clip(m.nick, 12.5, 220))}</text>`;
      by = y + 18;
    }

    out += `<rect x="${BUB_L}" y="${by}" width="${m.bw}" height="${m.bh}" rx="13" fill="${OTHER}"/>`;
    if (m.head) {
      out += `<path d="M${BUB_L} ${by + 10} L${BUB_L - 7} ${by + 13} L${BUB_L} ${by + 20} Z" fill="${OTHER}"/>`;
    }
    out += m.lines.map((ln, i) =>
      `<text x="${BUB_L + 15}" y="${by + 22 + i * LH}" class="msg">${esc(ln)}</text>`).join("");

    if (m.tail || m.unread) {
      const stampY = by + m.bh - 4;
      let sx = BUB_L + m.bw + 8;
      if (m.unread) {
        out += `<text x="${sx}" y="${stampY}" class="unread">${esc(m.unread)}</text>`;
        sx += Math.round(measure(m.unread, 11.5)) + 6;
      }
      if (m.tail) out += `<text x="${sx}" y="${stampY}" class="time">${m.time}</text>`;
    }
    y += m.h;
  }

  const roomLabel = clip(room, 18, W - 220);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="단톡방 ${esc(room)}">
  <style>
    text { font-family: system-ui, -apple-system, "SamsungOne", "Samsung Sans", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    .htitle { font-size: 18px; font-weight: 700; fill: #14171b; letter-spacing: -.6px; }
    .hcount { font-size: 15px; font-weight: 600; fill: #9aa3ad; letter-spacing: -.3px; }
    .sname { font-size: 11px; font-weight: 600; fill: #6b747e; letter-spacing: -.4px; }
    .notice { font-size: 13px; font-weight: 600; fill: #6b5320; letter-spacing: -.3px; }
    .day { font-size: 12.5px; font-weight: 600; fill: #ffffff; letter-spacing: -.2px; }
    .sys { font-size: 12.5px; font-weight: 500; fill: #ffffff; letter-spacing: -.2px; }
    .mn { font-size: 12.5px; font-weight: 600; fill: #2e3a48; letter-spacing: -.3px; }
    .msg { font-size: ${FS}px; font-weight: 450; fill: #1d2126; letter-spacing: -.3px; }
    .time { font-size: 11.5px; font-weight: 500; fill: #4b5a6b; letter-spacing: -.1px; }
    .unread { font-size: 11.5px; font-weight: 700; fill: ${ACCENT}; letter-spacing: -.1px; }
    .ph { font-size: 14px; font-weight: 450; fill: #a4adb8; letter-spacing: -.3px; }
  </style>
  ${portraitDefs(pics)}

  <rect width="${W}" height="${H}" fill="${BG}"/>

  <rect x="0" y="0" width="${W}" height="${STRIP_B}" fill="#ffffff"/>
  <line x1="0" y1="${STRIP_B}" x2="${W}" y2="${STRIP_B}" stroke="#d3dae4"/>
  <path d="M30 22 L22 30 L30 38" fill="none" stroke="#3b444e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="48" y="36" class="htitle">${esc(roomLabel)}</text>
  <text x="${54 + Math.round(measure(roomLabel, 18))}" y="36" class="hcount">${total}</text>
  <line x1="${W - 46}" y1="23" x2="${W - 22}" y2="23" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="${W - 46}" y1="30" x2="${W - 22}" y2="30" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="${W - 46}" y1="37" x2="${W - 22}" y2="37" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="0" y1="58" x2="${W}" y2="58" stroke="#eef1f5"/>
  ${memberStrip(members, pics)}

  ${notice ? `<rect x="0" y="${STRIP_B}" width="${W}" height="38" fill="#fff4d1"/>
  <line x1="0" y1="${STRIP_B + 38}" x2="${W}" y2="${STRIP_B + 38}" stroke="#f0e0ae"/>
  <circle cx="34" cy="${STRIP_B + 19}" r="8" fill="#e8b93c"/>
  <path d="M31 ${STRIP_B + 16} h6 v3 l-3 5 l-3 -5 Z" fill="#ffffff"/>
  <text x="52" y="${STRIP_B + 24}" class="notice">${esc(clip(notice, 13, W - 74))}</text>` : ""}

  ${out}

  <rect x="0" y="${H - 68}" width="${W}" height="68" fill="#ffffff"/>
  <line x1="0" y1="${H - 68}" x2="${W}" y2="${H - 68}" stroke="#d3dae4"/>
  <line x1="24" y1="${H - 34}" x2="42" y2="${H - 34}" stroke="#8a939d" stroke-width="2" stroke-linecap="round"/>
  <line x1="33" y1="${H - 43}" x2="33" y2="${H - 25}" stroke="#8a939d" stroke-width="2" stroke-linecap="round"/>
  <rect x="56" y="${H - 50}" width="${W - 112}" height="32" rx="16" fill="#f1f4f7"/>
  <text x="74" y="${H - 29}" class="ph">메시지 입력</text>
  <circle cx="${W - 30}" cy="${H - 34}" r="17" fill="${MINE}"/>
  <path d="M${W - 39} ${H - 41} L${W - 21} ${H - 34} L${W - 39} ${H - 27} L${W - 35} ${H - 34} Z" fill="#7a5f14"/>
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

    if (url.pathname === "/" && url.searchParams.get("x") === "1") {
      return new Response(request.method === "HEAD" ? null : await diagnose(), {
        status: 200,
        headers: { ...responseHeaders("text/plain; charset=utf-8"), "Cache-Control": "no-store" },
      });
    }

    const data = url.pathname === "/" ? parseInput(url) : null;
    if (!data) {
      return new Response(request.method === "HEAD" ? null : "Invalid parameters.", {
        status: 400,
        headers: responseHeaders("text/plain; charset=utf-8"),
      });
    }

    const wanted = [...data.members.map((m) => m.name), ...data.msgs.map((m) => m.nick)];
    const pics = request.method === "HEAD" ? new Map() : await loadPortraits(wanted);

    return new Response(request.method === "HEAD" ? null : chatSvg(data, pics), {
      status: 200,
      headers: responseHeaders("image/svg+xml; charset=utf-8"),
    });
  },
};
