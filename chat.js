/**
 * 단톡방 SVG Worker · 520x780 (세로형)
 * 카카오톡/라인/인스타 DM 참고. 단일 컬럼 대화.
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
 * 방어
 * - 허용 파라미터 외 키·중복 키·3000자 초과 쿼리는 400.
 * - 모든 텍스트의 XML 특수문자는 이스케이프.
 * - 이미지는 고정 호스트의 [주연 14명]01.webp 만. 임의 URL 불가.
 */

const W = 520;
const H = 780;

const BG = "#94a8c2";        // 대화 배경
const OTHER = "#ffffff";     // 말풍선
const ACCENT = "#ef6b4e";    // 안읽음 표시
const SEND = "#3d5a80";      // 보내기 버튼

const HEAD_B = 56;           // 헤더 바닥
const INPUT_H = 62;          // 입력바 높이
const AV_X = 14;             // 프로필 x
const BUB_L = 70;            // 말풍선 시작 x
const MAXB = 372;            // 말풍선 최대 폭
const FS = 17;               // 메시지 글자 크기
const LH = 24;               // 줄 높이

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
const thumbUrl = (name) =>
  `https://wsrv.nl/?url=${IMG_HOST.replace(/^https?:\/\//, "")}${encodeURIComponent(name)}01.webp` +
  `&w=128&h=128&fit=cover&a=top&output=webp&q=82`;

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
    return { kind, nick: fullName((nick || "익명").slice(0, 12)), text: text.slice(0, 180), unread };
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
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.32}" fill="${mix(c, 0.82)}"/>
  <circle cx="${x + s / 2}" cy="${y + s * 0.37}" r="${s * 0.163}" fill="${c}"/>
  <path d="M${x + s * 0.21} ${y + s * 0.87} a${s * 0.29} ${s * 0.27} 0 0 1 ${s * 0.58} 0 Z" fill="${c}"/>`;
}

// 같은 인물이 여러 번 나와도 이미지는 defs 에 한 번만 심는다
function portraitDefs(pics) {
  const syms = [...pics.entries()].map(([n, src]) =>
    `<symbol id="p${hash(n).toString(36)}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin slice">
      <image href="${src}" xlink:href="${src}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMin slice"/>
    </symbol>`).join("");
  return `<defs>
    <clipPath id="rnd" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.32" ry="0.32"/></clipPath>
    ${syms}
  </defs>`;
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

  const chatTop = (notice ? HEAD_B + 36 : HEAD_B) + 14;
  const chatBottom = H - INPUT_H - 12;

  // 높이 계산
  const NAME_H = 18;
  const laid = [];
  let showDay = !!day;
  let hSum = showDay ? 40 : 0;
  for (const m of items) {
    if (m.kind === "sys") {
      m.h = 36;
      laid.push(m);
      hSum += 36;
      continue;
    }
    m.lines = wrapText(m.text, FS, MAXB - 32, 5);
    m.bw = Math.min(MAXB, Math.round(Math.max(...m.lines.map((l) => measure(l, FS)))) + 32);
    m.bh = m.lines.length * LH + 14;
    m.h = (m.head ? NAME_H : 0) + m.bh + (m.tail ? 8 : 3);
    if (m.head) m.h = Math.max(m.h, 46 + (m.tail ? 8 : 3));
    laid.push(m);
    hSum += m.h;
  }

  // 넘치면 실제 대화창처럼 오래된 것부터 밀어낸다
  const avail = chatBottom - chatTop;
  if (hSum > avail && showDay) { showDay = false; hSum -= 40; }
  while (laid.length > 1 && hSum > avail) {
    hSum -= laid.shift().h;
    if (laid.length && laid[0].kind !== "sys" && !laid[0].head) {
      laid[0].head = true;
      laid[0].h += NAME_H;
      hSum += NAME_H;
    }
  }

  let y = Math.max(chatTop, chatBottom - hSum);
  const CX = W / 2;

  let out = "";
  if (showDay) {
    const dw = Math.round(measure(day, 12)) + 30;
    out += `<rect x="${CX - dw / 2}" y="${y + 3}" width="${dw}" height="25" rx="12.5" fill="#1d2b3a" opacity=".22"/>
    <text x="${CX}" y="${y + 20}" text-anchor="middle" class="day">${esc(day)}</text>`;
    y += 40;
  }

  for (const m of laid) {
    if (m.kind === "sys") {
      const sw = Math.round(measure(m.text, 12)) + 30;
      out += `<rect x="${CX - sw / 2}" y="${y + 2}" width="${sw}" height="25" rx="12.5" fill="#1d2b3a" opacity=".18"/>
      <text x="${CX}" y="${y + 19}" text-anchor="middle" class="sys">${esc(m.text)}</text>`;
      y += m.h;
      continue;
    }

    let by = y;
    if (m.head) {
      out += `${avatar(AV_X, y, 46, m.nick, pics)}
      <text x="${BUB_L}" y="${y + 12}" class="mn">${esc(clip(m.nick, 12.5, 220))}</text>`;
      by = y + NAME_H;
    }

    out += `<rect x="${BUB_L}" y="${by}" width="${m.bw}" height="${m.bh}" rx="17" fill="${OTHER}"/>`;
    if (m.head) {
      out += `<path d="M${BUB_L + 2} ${by + 9} q-9 3 -9 10 q5 -4 9 -3 Z" fill="${OTHER}"/>`;
    }
    out += m.lines.map((ln, i) =>
      `<text x="${BUB_L + 16}" y="${by + 23 + i * LH}" class="msg">${esc(ln)}</text>`).join("");

    if (m.tail || m.unread) {
      const stampY = by + m.bh - 5;
      const stampW = (m.unread ? measure(m.unread, 11) + 5 : 0) + (m.tail ? measure(m.time, 11) : 0);
      let sx = Math.min(BUB_L + m.bw + 7, W - 10 - stampW);
      if (m.unread) {
        out += `<text x="${sx}" y="${stampY}" class="unread">${esc(m.unread)}</text>`;
        sx += Math.round(measure(m.unread, 11)) + 5;
      }
      if (m.tail) out += `<text x="${sx}" y="${stampY}" class="time">${m.time}</text>`;
    }
    y += m.h;
  }

  const roomLabel = clip(room, 18, W - 190);
  const nameW = Math.round(measure(roomLabel, 18));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="단톡방 ${esc(room)}">
  <style>
    text { font-family: Pretendard, -apple-system, "SamsungOne", "Samsung Sans", system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    .htitle { font-size: 18px; font-weight: 700; fill: #141a21; letter-spacing: -.7px; }
    .hcount { font-size: 12.5px; font-weight: 700; fill: #7b8794; letter-spacing: -.2px; }
    .notice { font-size: 12.5px; font-weight: 600; fill: #6a5316; letter-spacing: -.35px; }
    .day { font-size: 12px; font-weight: 600; fill: #ffffff; letter-spacing: -.2px; }
    .sys { font-size: 12px; font-weight: 500; fill: #ffffff; letter-spacing: -.2px; }
    .mn { font-size: 12.5px; font-weight: 600; fill: #33414f; letter-spacing: -.4px; }
    .msg { font-size: ${FS}px; font-weight: 420; fill: #171b20; letter-spacing: -.45px; }
    .time { font-size: 11px; font-weight: 500; fill: #4e5f73; letter-spacing: -.1px; }
    .unread { font-size: 11px; font-weight: 700; fill: ${ACCENT}; letter-spacing: -.1px; }
    .ph { font-size: 13.5px; font-weight: 450; fill: #9aa4b0; letter-spacing: -.35px; }
  </style>
  ${portraitDefs(pics)}

  <rect width="${W}" height="${H}" fill="${BG}"/>

  <rect x="0" y="0" width="${W}" height="${HEAD_B}" fill="#ffffff"/>
  <line x1="0" y1="${HEAD_B}" x2="${W}" y2="${HEAD_B}" stroke="#d4dbe4"/>
  <path d="M24 20 L16 28 L24 36" fill="none" stroke="#2f3944" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
  ${avatar(36, 12, 32, room, pics)}
  <text x="78" y="34" class="htitle">${esc(roomLabel)}</text>
  <rect x="${84 + nameW}" y="18" width="${20 + String(total).length * 7}" height="19" rx="9.5" fill="#eef1f5"/>
  <text x="${94 + nameW + String(total).length * 3.5}" y="31.5" text-anchor="middle" class="hcount">${total}</text>
  <circle cx="${W - 44}" cy="28" r="2.1" fill="#5c6875"/>
  <circle cx="${W - 34}" cy="28" r="2.1" fill="#5c6875"/>
  <circle cx="${W - 24}" cy="28" r="2.1" fill="#5c6875"/>

  ${notice ? `<rect x="0" y="${HEAD_B}" width="${W}" height="36" fill="#fdf3d4"/>
  <line x1="0" y1="${HEAD_B + 36}" x2="${W}" y2="${HEAD_B + 36}" stroke="#efe2b4"/>
  <path d="M22 ${HEAD_B + 10} h13 v10 l-6.5 7 l-6.5 -7 Z" fill="#dfae32"/>
  <text x="46" y="${HEAD_B + 23}" class="notice">${esc(clip(notice, 12.5, W - 68))}</text>` : ""}

  ${out}

  <rect x="0" y="${H - INPUT_H}" width="${W}" height="${INPUT_H}" fill="#ffffff"/>
  <line x1="0" y1="${H - INPUT_H}" x2="${W}" y2="${H - INPUT_H}" stroke="#d4dbe4"/>
  <line x1="18" y1="${H - 31}" x2="34" y2="${H - 31}" stroke="#98a3b0" stroke-width="2" stroke-linecap="round"/>
  <line x1="26" y1="${H - 39}" x2="26" y2="${H - 23}" stroke="#98a3b0" stroke-width="2" stroke-linecap="round"/>
  <rect x="46" y="${H - 46}" width="${W - 104}" height="31" rx="15.5" fill="#f0f3f7"/>
  <text x="63" y="${H - 25}" class="ph">메시지 입력</text>
  <circle cx="${W - 30}" cy="${H - 31}" r="16" fill="${SEND}"/>
  <path d="M${W - 38} ${H - 38} L${W - 21} ${H - 31} L${W - 38} ${H - 24} L${W - 34.5} ${H - 31} Z" fill="#ffffff"/>
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

    const wanted = [...data.msgs.map((m) => m.nick), ...data.members.map((m) => m.name)];
    const pics = request.method === "HEAD" ? new Map() : await loadPortraits(wanted);

    return new Response(request.method === "HEAD" ? null : chatSvg(data, pics), {
      status: 200,
      headers: responseHeaders("image/svg+xml; charset=utf-8"),
    });
  },
};
