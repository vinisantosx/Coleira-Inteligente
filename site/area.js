// Área segura: círculo (casa + raio) ou contorno desenhado (polígono de 3 a 16 cantos).
// As contas são as mesmas do firmware (coleira_esp32.ino), para o site e a coleira concordarem.

export const MAX_CANTOS = 16;          // mesmo limite das regras do Firestore e do firmware
export const LADO_MINIMO_M = 15;       // lados menores que isso ficam abaixo do erro do GPS
export const LARGURA_MINIMA_M = 10;    // "meia largura" abaixo disso: o GPS não distingue dentro de fora

const R = 6371000, rad = Math.PI / 180;

export function distanciaM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// projeção plana em metros em torno da casa (boa para algumas centenas de metros)
function xy(a, lat, lng) {
  return [(lng - a.lng) * rad * R * Math.cos(a.lat * rad), (lat - a.lat) * rad * R];
}
function deXY(a, x, y) {
  return { lat: +(a.lat + y / (rad * R)).toFixed(7), lng: +(a.lng + x / (rad * R * Math.cos(a.lat * rad))).toFixed(7) };
}

function distSegmento(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

export const ehPoligono = (a) => a?.forma === 'poligono' && Array.isArray(a.pontos) && a.pontos.length >= 3;

// Distância até o limite, com sinal: negativa = dentro, positiva = fora.
export function limiteArea(a, lat, lng) {
  if (!ehPoligono(a)) return distanciaM(a.lat, a.lng, lat, lng) - a.raio;
  const [px, py] = xy(a, lat, lng), p = a.pontos.map((q) => xy(a, q.lat, q.lng));
  let dentro = false, menor = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dentro = !dentro;
    menor = Math.min(menor, distSegmento(px, py, xi, yi, xj, yj));
  }
  return dentro ? -menor : menor;
}

// "Meia largura" (2 × área ÷ perímetro): num quadrado de 40 m dá 20 m. Usada para a margem e a régua.
export function escalaArea(a) {
  if (!ehPoligono(a)) return a.raio;
  const p = a.pontos.map((q) => xy(a, q.lat, q.lng));
  let area2 = 0, perim = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    area2 += p[j][0] * p[i][1] - p[i][0] * p[j][1];
    perim += Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
  }
  return perim > 0 ? Math.abs(area2) / perim : 0;
}

export function areaM2(a) {
  if (!ehPoligono(a)) return Math.PI * a.raio * a.raio;
  const p = a.pontos.map((q) => xy(a, q.lat, q.lng));
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(s) / 2;
}

// Raio que cobre o contorno a partir da casa: vira o "raio" salvo junto (escala do mapa,
// simulação e reserva para firmwares antigos que só entendem círculo).
function raioCobertura(a) {
  const r = Math.max(...a.pontos.map((q) => distanciaM(a.lat, a.lng, q.lat, q.lng)));
  return Math.max(5, Math.min(5000, Math.ceil(r)));
}

// Deixa a área consistente: no polígono, o raio passa a ser o de cobertura.
export function completar(a) {
  const b = { forma: ehPoligono(a) ? 'poligono' : 'circulo', lat: a.lat, lng: a.lng, raio: a.raio };
  if (a.pontos) b.pontos = a.pontos.map((q) => ({ lat: +q.lat, lng: +q.lng }));
  if (b.forma === 'poligono') b.raio = raioCobertura(b);
  return b;
}

// Lê o que veio do Firestore ou do navegador; qualquer coisa estranha vira círculo.
export function normalizarArea(d, padrao) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!d || !num(d.lat) || !num(d.lng) || !num(d.raio)) return padrao ? completar({ ...padrao }) : null;
  const a = { forma: 'circulo', lat: d.lat, lng: d.lng, raio: d.raio };
  const pts = Array.isArray(d.pontos) ? d.pontos.filter((q) => q && num(q.lat) && num(q.lng)) : [];
  if (pts.length) a.pontos = pts.slice(0, MAX_CANTOS).map((q) => ({ lat: q.lat, lng: q.lng }));
  if (d.forma === 'poligono' && pts.length >= 3 && pts.length <= MAX_CANTOS) a.forma = 'poligono';
  return completar(a);
}

// O que vai para pets/{pet}/config/area (o círculo não leva os pontos).
export function paraFirestore(a) {
  const b = completar(a);
  if (b.forma === 'circulo') delete b.pontos;
  return b;
}

export function mesmaArea(a, b) {
  if (!a || !b) return a === b;
  return JSON.stringify(paraFirestore(a)) === JSON.stringify(paraFirestore(b));
}

// Retângulo de partida em volta da casa (lados alinhados ao norte), com meia largura em metros.
export function retangulo(casa, meiaLeste, meiaNorte = meiaLeste) {
  return [[-meiaLeste, -meiaNorte], [meiaLeste, -meiaNorte], [meiaLeste, meiaNorte], [-meiaLeste, meiaNorte]]
    .map(([x, y]) => deXY(casa, x, y));
}

// Ponto no meio de um lado (para o "+" de adicionar canto).
export function meioDoLado(a, i) {
  const p = a.pontos[i], q = a.pontos[(i + 1) % a.pontos.length];
  return { lat: +((p.lat + q.lat) / 2).toFixed(7), lng: +((p.lng + q.lng) / 2).toFixed(7) };
}

function cruzam(p1, p2, p3, p4) {
  const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p1, p2, p3) * o(p1, p2, p4) < 0 && o(p3, p4, p1) * o(p3, p4, p2) < 0;
}

// Confere o contorno antes de salvar. erro = não pode salvar; avisos = pode, mas atenção.
export function validarArea(a) {
  const avisos = [];
  if (!ehPoligono(a)) {
    if (a.forma === 'poligono') return { erro: 'O contorno precisa de pelo menos 3 cantos.', avisos };
    return { erro: null, avisos };
  }
  const n = a.pontos.length;
  if (n > MAX_CANTOS) return { erro: `Use no máximo ${MAX_CANTOS} cantos.`, avisos };
  const p = a.pontos.map((q) => xy(a, q.lat, q.lng));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;     // lados vizinhos
      if (cruzam(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) {
        return { erro: 'O contorno cruza a si mesmo. Arraste os cantos para que os lados não se cruzem.', avisos };
      }
    }
  }
  if (limiteArea(a, a.lat, a.lng) > 0) avisos.push('A casa ficou fora do contorno: com o pet em casa, a coleira vai avisar que ele saiu.');
  const menorLado = Math.min(...p.map((q, i) => Math.hypot(q[0] - p[(i + 1) % n][0], q[1] - p[(i + 1) % n][1])));
  if (escalaArea(a) < LARGURA_MINIMA_M) {
    avisos.push('A área está mais estreita que o erro do GPS (5 a 15 m). Os avisos de saída podem atrasar ou falhar.');
  } else if (menorLado < LADO_MINIMO_M) {
    avisos.push(`Há um lado com ${Math.round(menorLado)} m. O GPS erra de 5 a 15 m; recortes pequenos não fazem diferença.`);
  }
  return { erro: null, avisos };
}
