/**
 * 단톡방 SVG Worker · 1000x640
 * 카카오톡/라인/인스타 DM 을 참고한 자체 메신저 UI. 좌측 멤버 패널 + 우측 대화.
 *
 * 파라미터
 * - r: 방 이름 (예: 용살단 3분대)
 * - d: 날짜 구분선 문구 (예: 2045년 7월 14일 금요일)
 * - t: 시작 시각 HH:MM (말풍선 묶음마다 1분씩 진행)
 * - p: 상단 고정 공지 1줄 (생략 가능)
 * - m: 멤버 "이름" 또는 "이름~상태메시지", ; 구분 (최대 6). 생략 시 발신자에서 자동 추출
 * - l: 메시지, ; 구분 (최대 10)
 *      상대  : 닉~내용   또는 닉~내용~안읽음수
 *      나    : >내용     또는 >내용~안읽음수
 *      시스템: !내용     (가운데 회색 칩)
 *
 * 같은 사람이 연달아 말하면 프로필·이름은 첫 줄에만, 시각은 마지막 줄에만 붙음.
 * 공백은 + 로 표기. 퍼센트 인코딩 불필요.
 *
 * 주의: 대화 내용이 URL 에 실려 Cloudflare 네트워크를 경유함.
 * 배포 후 Worker Settings > Observability 에서 Workers Logs 를 반드시 비활성화할 것.
 *
 * 방어
 * - 허용 파라미터 외 키·중복 키·3000자 초과 쿼리는 400.
 * - 모든 텍스트의 XML 특수문자는 이스케이프.
 * - 외부 통신·저장소·분석 코드 없음. IP·헤더·쿠키 미참조.
 */

const W = 860;
const H = 640;

const BG = "#93a8c4";        // 대화 배경
const MINE = "#ffe6a3";      // 내 말풍선
const OTHER = "#ffffff";     // 상대 말풍선
const PANEL = "#ffffff";     // 좌측 패널
const ACCENT = "#e8654a";    // 안읽음 표시

const PANEL_W = 210;
const CHAT_L = PANEL_W;
const AV_X = 228;            // 상대 프로필 x
const BUB_L = 272;           // 상대 말풍선 시작 x
const BUB_R = 836;           // 내 말풍선 끝 x
const MAXB = 348;            // 말풍선 최대 폭
const FS = 15.5;             // 메시지 글자 크기
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
const MAX_PICS = 6;
const MAX_ONE = 400 * 1024;
const MAX_ALL = 1500 * 1024;

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
      const res = await fetch(`${IMG_HOST}${encodeURIComponent(n)}01.webp`, {
        cf: { cacheEverything: true, cacheTtl: 86400 },
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

  const msgs = get("l").split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 10).map((row) => {
    let r = row;
    let kind = "other";
    if (r.startsWith(">")) { kind = "mine"; r = r.slice(1).trim(); }
    else if (r.startsWith("!")) { kind = "sys"; r = r.slice(1).trim(); }

    let unread = "";
    const u = r.lastIndexOf("~");
    if (u > 0 && /^\d{1,2}$/.test(r.slice(u + 1).trim())) {
      unread = r.slice(u + 1).trim();
      r = r.slice(0, u).trim();
    }

    if (kind === "sys") return { kind, nick: "", text: r.slice(0, 60), unread: "" };
    if (kind === "mine") return { kind, nick: "", text: r.slice(0, 120), unread };

    const k = r.indexOf("~");
    let nick = k === -1 ? "" : r.slice(0, k).trim();
    let text = k === -1 ? r : r.slice(k + 1).trim();
    if (!text) { text = nick; nick = ""; }
    if (nick.length > 12) { text = nick + (text ? " " + text : ""); nick = ""; }
    return { kind, nick: fullName((nick || "익명").slice(0, 12)), text: text.slice(0, 120), unread };
  }).filter((m) => m.text);

  let members = get("m").split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 6).map((row) => {
    const k = row.indexOf("~");
    return {
      name: fullName((k === -1 ? row : row.slice(0, k)).trim().slice(0, 12)) || "익명",
      note: (k === -1 ? "" : row.slice(k + 1)).trim().slice(0, 20),
    };
  });
  if (!members.length) {
    const uniq = [];
    for (const m of msgs) if (m.kind === "other" && !uniq.includes(m.nick)) uniq.push(m.nick);
    members = uniq.slice(0, 6).map((name) => ({ name, note: "" }));
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
  const rows = await Promise.all(names.map(async (n) => {
    const url = `${IMG_HOST}${encodeURIComponent(n)}01.webp`;
    try {
      const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
      const type = (res.headers.get("content-type") || "-").split(";")[0].trim();
      if (!res.ok) return `${n}  HTTP ${res.status}  ${type}  -`;
      const buf = new Uint8Array(await res.arrayBuffer());
      const kb = (buf.length / 1024).toFixed(1);
      const ok = buf.length <= MAX_ONE && /^image\//.test(type) ? "OK" : "제외";
      return `${n}  HTTP ${res.status}  ${type}  ${kb}KB  ${ok}`;
    } catch (e) {
      return `${n}  FETCH 실패  ${String(e).slice(0, 60)}`;
    }
  }));
  return [
    "== 인물 01 이미지 진단 ==",
    `호스트 ${IMG_HOST}`,
    `한 장 상한 ${(MAX_ONE / 1024).toFixed(0)}KB · 합계 상한 ${(MAX_ALL / 1024).toFixed(0)}KB · 최대 ${MAX_PICS}명`,
    `Buffer(nodejs_compat) ${typeof Buffer !== "undefined" ? "있음" : "없음"}`,
    "",
    ...rows,
  ].join("\n");
}

// 프로필. 인물 01 이미지가 실리면 사진, 아니면 색 구분 실루엣
function avatar(x, y, s, name, pics) {
  if (pics && pics.has(name)) {
    return `<use href="#p${hash(name).toString(36)}" x="${x}" y="${y}" width="${s}" height="${s}" clip-path="url(#rnd)"/>`;
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
      <image href="${src}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMin slice"/>
    </symbol>`).join("");
  return `<defs>
    <clipPath id="rnd" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.34" ry="0.34"/></clipPath>
    ${syms}
  </defs>`;
}

function sidePanel({ room, members }, pics) {
  const total = members.length + 1;
  const rows = members.map((m, i) => {
    const y = 200 + i * 44;
    const nameY = m.note ? y + 13 : y + 19;
    return `${avatar(22, y, 28, m.name, pics)}
    <text x="58" y="${nameY}" class="mname">${esc(clip(m.name, 14, 124))}</text>
    ${m.note ? `<text x="58" y="${y + 27}" class="mnote">${esc(clip(m.note, 11.5, 130))}</text>` : ""}`;
  }).join("");

  return `
  <rect x="0" y="58" width="${PANEL_W}" height="${H - 58}" fill="${PANEL}"/>
  <line x1="${PANEL_W}" y1="58" x2="${PANEL_W}" y2="${H}" stroke="#d3dae4"/>
  ${avatar(22, 78, 48, room, pics)}
  <text x="78" y="99" class="rname">${esc(clip(room, 16.5, 106))}</text>
  <text x="78" y="119" class="rsub">멤버 ${total}명</text>
  <line x1="22" y1="154" x2="188" y2="154" stroke="#eceff3"/>
  <text x="22" y="178" class="mlabel">대화상대 ${members.length}</text>
  ${rows}`;
}

function chatSvg({ room, day, base, notice, msgs, members }, pics) {
  const total = members.length + 1;

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

  // 묶음 번호로 시각 배정
  let g = -1;
  items.forEach((m) => {
    if (m.head) g += 1;
    m.time = m.kind === "sys" ? "" : addTime(base, g);
  });

  // 높이 계산
  const laid = [];
  let hSum = day ? 42 : 0;
  for (const m of items) {
    if (m.kind === "sys") {
      m.h = 40;
      laid.push(m);
      hSum += 40;
      continue;
    }
    m.lines = wrapText(m.text, FS, MAXB - 30, 4);
    m.bw = Math.min(MAXB, Math.round(Math.max(...m.lines.map((l) => measure(l, FS)))) + 30);
    m.bh = m.lines.length * LH + 20;
    m.h = (m.head && m.kind === "other" ? 20 : 0) + m.bh + (m.tail ? 12 : 5);
    laid.push(m);
    hSum += m.h;
  }

  const chatTop = notice ? 104 : 70;
  const chatBottom = 572;
  let y = Math.max(chatTop, chatBottom - hSum);
  const CX = (CHAT_L + W) / 2;

  let out = "";
  if (day) {
    const dw = Math.round(measure(day, 12.5)) + 30;
    out += `<rect x="${CX - dw / 2}" y="${y + 4}" width="${dw}" height="26" rx="13" fill="#000000" opacity=".16"/>
    <text x="${CX}" y="${y + 22}" text-anchor="middle" class="day">${esc(day)}</text>`;
    y += 42;
  }

  for (const m of laid) {
    if (m.kind === "sys") {
      const sw = Math.round(measure(m.text, 12.5)) + 30;
      out += `<rect x="${CX - sw / 2}" y="${y + 3}" width="${sw}" height="26" rx="13" fill="#000000" opacity=".13"/>
      <text x="${CX}" y="${y + 21}" text-anchor="middle" class="sys">${esc(m.text)}</text>`;
      y += m.h;
      continue;
    }

    const mine = m.kind === "mine";
    let by = y;

    if (m.head && !mine) {
      out += `${avatar(AV_X, y, 36, m.nick, pics)}
      <text x="${BUB_L}" y="${y + 12}" class="mn">${esc(clip(m.nick, 12.5, 200))}</text>`;
      by = y + 20;
    }

    const bx = mine ? BUB_R - m.bw : BUB_L;
    const fill = mine ? MINE : OTHER;

    out += `<rect x="${bx}" y="${by}" width="${m.bw}" height="${m.bh}" rx="14" fill="${fill}"/>`;
    if (m.head) {
      out += mine
        ? `<path d="M${bx + m.bw} ${by + 11} L${bx + m.bw + 7} ${by + 14} L${bx + m.bw} ${by + 21} Z" fill="${fill}"/>`
        : `<path d="M${bx} ${by + 11} L${bx - 7} ${by + 14} L${bx} ${by + 21} Z" fill="${fill}"/>`;
    }
    out += m.lines.map((ln, i) =>
      `<text x="${bx + 15}" y="${by + 24 + i * LH}" class="msg">${esc(ln)}</text>`).join("");

    if (m.tail || m.unread) {
      const stampY = by + m.bh - 4;
      const stamp = m.tail ? m.time : "";
      if (mine) {
        const sx = bx - 8;
        if (stamp) out += `<text x="${sx}" y="${stampY}" text-anchor="end" class="time">${stamp}</text>`;
        if (m.unread) {
          const ux = stamp ? sx - Math.round(measure(stamp, 11.5)) - 7 : sx;
          out += `<text x="${ux}" y="${stampY}" text-anchor="end" class="unread">${esc(m.unread)}</text>`;
        }
      } else {
        let sx = bx + m.bw + 8;
        if (m.unread) {
          out += `<text x="${sx}" y="${stampY}" class="unread">${esc(m.unread)}</text>`;
          sx += Math.round(measure(m.unread, 11.5)) + 7;
        }
        if (stamp) out += `<text x="${sx}" y="${stampY}" class="time">${stamp}</text>`;
      }
    }
    y += m.h;
  }

  const roomLabel = clip(room, 18, 240);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="단톡방 ${esc(room)}">
  <style>
    text { font-family: system-ui, -apple-system, "SamsungOne", "Samsung Sans", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    .htitle { font-size: 18px; font-weight: 700; fill: #14171b; letter-spacing: -.6px; }
    .hcount { font-size: 15px; font-weight: 600; fill: #9aa3ad; letter-spacing: -.3px; }
    .rname { font-size: 17px; font-weight: 700; fill: #14171b; letter-spacing: -.6px; }
    .rsub { font-size: 12.5px; font-weight: 500; fill: #9aa3ad; letter-spacing: -.2px; }
    .mlabel { font-size: 12px; font-weight: 700; fill: #a4adb8; letter-spacing: -.2px; }
    .mname { font-size: 14px; font-weight: 600; fill: #2b3138; letter-spacing: -.3px; }
    .mnote { font-size: 11.5px; font-weight: 450; fill: #a4adb8; letter-spacing: -.2px; }
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
  ${sidePanel({ room, members }, pics)}

  <rect x="0" y="0" width="${W}" height="58" fill="#ffffff"/>
  <line x1="0" y1="58" x2="${W}" y2="58" stroke="#d3dae4"/>
  <path d="M34 22 L26 30 L34 38" fill="none" stroke="#3b444e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="54" y="36" class="htitle">${esc(roomLabel)}</text>
  <text x="${60 + Math.round(measure(roomLabel, 18))}" y="36" class="hcount">${total}</text>
  <circle cx="780" cy="28" r="7" fill="none" stroke="#6b747e" stroke-width="2"/>
  <line x1="785" y1="33" x2="791" y2="39" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="808" y1="23" x2="830" y2="23" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="808" y1="30" x2="830" y2="30" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>
  <line x1="808" y1="37" x2="830" y2="37" stroke="#6b747e" stroke-width="2" stroke-linecap="round"/>

  ${notice ? `<rect x="${CHAT_L}" y="58" width="${W - CHAT_L}" height="38" fill="#fff4d1"/>
  <line x1="${CHAT_L}" y1="96" x2="${W}" y2="96" stroke="#f0e0ae"/>
  <circle cx="${CHAT_L + 30}" cy="77" r="8" fill="#e8b93c"/>
  <path d="M${CHAT_L + 27} 74 h6 v3 l-3 5 l-3 -5 Z" fill="#ffffff"/>
  <text x="${CHAT_L + 48}" y="82" class="notice">${esc(clip(notice, 13, W - CHAT_L - 72))}</text>` : ""}

  ${out}

  <rect x="${CHAT_L}" y="578" width="${W - CHAT_L}" height="${H - 578}" fill="#ffffff"/>
  <line x1="${CHAT_L}" y1="578" x2="${W}" y2="578" stroke="#d3dae4"/>
  <line x1="${CHAT_L + 24}" y1="609" x2="${CHAT_L + 42}" y2="609" stroke="#8a939d" stroke-width="2" stroke-linecap="round"/>
  <line x1="${CHAT_L + 33}" y1="600" x2="${CHAT_L + 33}" y2="618" stroke="#8a939d" stroke-width="2" stroke-linecap="round"/>
  <rect x="${CHAT_L + 56}" y="594" width="${BUB_R - CHAT_L - 112}" height="32" rx="16" fill="#f1f4f7"/>
  <text x="${CHAT_L + 74}" y="615" class="ph">메시지 입력</text>
  <circle cx="${BUB_R - 24}" cy="610" r="17" fill="${MINE}"/>
  <path d="M${BUB_R - 33} 603 L${BUB_R - 15} 610 L${BUB_R - 33} 617 L${BUB_R - 29} 610 Z" fill="#7a5f14"/>
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
