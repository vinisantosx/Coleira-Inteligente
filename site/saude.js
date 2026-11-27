// Saúde comparada com o próprio pet: análise dos resumos diários e gráficos.
//
// Cada dia (Firestore saude/{pet}_{AAAA-MM-DD}, escrito pela coleira) tem:
//   distanciaM, minutosAtivos, bpmRepousoSoma, bpmRepousoN (minutos de repouso medidos)
// O "normal" do pet vem da coleira (pets/{pet}.baseRepouso, que ela aprende sozinha).
// Sem isso (ex.: simulação), o site calcula a partir dos dias guardados.

export const MIN_MIN_REPOUSO_DIA = 30;   // igual ao firmware
export const DIAS_PARA_APRENDER = 3;

const NS = 'http://www.w3.org/2000/svg';
const DIA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function dataLocal(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function diasAtras(n, base = new Date()) {
  const d = new Date(base); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d;
}
const paraDate = (s) => new Date(s + 'T12:00:00');
const mediana = (v) => {
  if (!v.length) return null;
  const o = [...v].sort((a, b) => a - b), m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};
const repousoDoDia = (d, minimo = MIN_MIN_REPOUSO_DIA) => (d && d.bpmRepousoN >= minimo ? d.bpmRepousoSoma / d.bpmRepousoN : null);

// ------------------------------------------------------------ histórico de exemplo
// Determinístico (mesmos números a cada recarga), com dois dias mais parados.
export function historicoExemplo(dias = 13) {
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const lista = [];
  for (let i = dias; i >= 1; i--) {
    const parado = i === 4 || i === 10;
    const minutos = Math.round(parado ? 32 + rnd() * 10 : 82 + rnd() * 32);
    const n = Math.round(70 + rnd() * 120);
    const repouso = 85 + (rnd() - 0.5) * 7 + (parado ? 3 : 0);
    lista.push({
      data: dataLocal(diasAtras(i)), minutosAtivos: minutos,
      distanciaM: Math.round(minutos * (40 + rnd() * 16)),
      bpmRepousoSoma: Math.round(repouso * n), bpmRepousoN: n
    });
  }
  return lista;
}

// ------------------------------------------------------------ análise
export function analisar({ dias, hoje, estado, nome }) {
  const passados = dias.filter((d) => d.data < hoje.data).sort((a, b) => (a.data < b.data ? -1 : 1)).slice(-14);

  // normal do batimento em repouso: da coleira, se ela já aprendeu; senão, dos dias guardados
  let media, desvio, nDias, fonte;
  if (estado?.baseDias >= 1 && estado?.baseRepouso > 0) {
    media = +estado.baseRepouso; desvio = +estado.baseDesvio || 4; nDias = +estado.baseDias; fonte = 'coleira';
  } else {
    const valores = passados.map((d) => repousoDoDia(d)).filter((v) => v != null);
    media = mediana(valores);
    const m = valores.reduce((s, v) => s + v, 0) / (valores.length || 1);
    desvio = Math.max(3, Math.sqrt(valores.reduce((s, v) => s + (v - m) ** 2, 0) / (valores.length || 1)));
    nDias = valores.length; fonte = 'site';
  }
  const aprendendo = !media || nDias < DIAS_PARA_APRENDER;
  const limite = media ? Math.max(0.2 * media, 3 * desvio, 12) : null;
  const faixa = media ? [Math.round(media - limite), Math.round(media + limite)] : null;

  const repousoHoje = repousoDoDia(hoje, 5);
  const agora = estado?.bpmRepouso > 0 ? +estado.bpmRepouso : null;
  const referencia = agora ?? repousoHoje;
  let statusBpm = 'sem-dados';
  if (aprendendo) statusBpm = 'aprendendo';
  else if (estado?.saudeAlerta === 'alto' || estado?.saudeAlerta === 'baixo') statusBpm = estado.saudeAlerta;
  else if (referencia != null) statusBpm = referencia > faixa[1] ? 'alto' : referencia < faixa[0] ? 'baixo' : 'normal';

  // atividade
  const comAtividade = passados.filter((d) => d.minutosAtivos != null);
  const normalMin = mediana(comAtividade.map((d) => d.minutosAtivos));
  const normalDist = mediana(comAtividade.map((d) => d.distanciaM || 0));
  const pctHoje = normalMin ? (hoje.minutosAtivos || 0) / normalMin : null;
  const horaAgora = new Date().getHours();
  const hojeParado = pctHoje != null && horaAgora >= 20 && pctHoje < 0.6;
  const diasParados = comAtividade.filter((d) => normalMin && d.minutosAtivos < 0.6 * normalMin);

  // tendência do repouso: últimos 7 dias contra os 7 anteriores
  const rep = passados.map((d) => repousoDoDia(d));
  const ult7 = rep.slice(-7).filter((v) => v != null), ant7 = rep.slice(-14, -7).filter((v) => v != null);
  const tendencia = ult7.length >= 3 && ant7.length >= 3 ? (mediana(ult7) - mediana(ant7)) / mediana(ant7) : null;

  // o que a coleira percebeu, em linguagem simples
  const ins = [];
  if (aprendendo) {
    ins.push({ tipo: 'info', texto: `A coleira ainda está aprendendo o normal de ${nome}: ${nDias || 0} de ${DIAS_PARA_APRENDER} dias com pelo menos ${MIN_MIN_REPOUSO_DIA} minutos de repouso medidos.` });
  } else if (statusBpm === 'alto' || statusBpm === 'baixo') {
    const dif = Math.round(Math.abs((referencia ?? media) - media) / media * 100);
    ins.push({ tipo: 'alerta', texto: `O batimento em repouso de ${nome} está ${dif}% ${statusBpm === 'alto' ? 'acima' : 'abaixo'} do normal dele (${Math.round(referencia ?? 0)} bpm, normal ${Math.round(media)}). Observe se está ofegante, agitado, com calor ou mais quieto que o normal. Se continuar, fale com o veterinário.` });
  } else if (referencia != null) {
    ins.push({ tipo: 'bom', texto: `O batimento em repouso de hoje (${Math.round(referencia)} bpm) está dentro do normal de ${nome}.` });
  } else {
    ins.push({ tipo: 'info', texto: `Ainda não houve repouso suficiente hoje para medir o batimento em repouso.` });
  }
  if (tendencia != null && Math.abs(tendencia) >= 0.08) {
    ins.push({ tipo: 'aviso', texto: `Na última semana, o batimento em repouso ${tendencia > 0 ? 'subiu' : 'caiu'} ${Math.round(Math.abs(tendencia) * 100)}% em relação à semana anterior.` });
  } else if (tendencia != null) {
    ins.push({ tipo: 'bom', texto: 'O batimento em repouso está estável nas últimas duas semanas.' });
  }
  if (pctHoje != null) {
    if (hojeParado) ins.push({ tipo: 'aviso', texto: `Hoje foi um dia mais parado: ${hoje.minutosAtivos} min ativos, ${Math.round(pctHoje * 100)}% do normal de ${nome}.` });
    else if (pctHoje >= 1) ins.push({ tipo: 'bom', texto: `${nome} já atingiu o tempo ativo normal dele hoje (${hoje.minutosAtivos} de ~${Math.round(normalMin)} min).` });
    else ins.push({ tipo: 'info', texto: `Até agora, ${hoje.minutosAtivos || 0} min ativos hoje. Num dia normal, ${nome} soma cerca de ${Math.round(normalMin)} min.` });
  }
  if (diasParados.length) {
    const nomes = diasParados.slice(-3).map((d) => DIA_SEMANA[paraDate(d.data).getDay()]).join(', ');
    ins.push({ tipo: diasParados.length >= 3 ? 'aviso' : 'info', texto: `${diasParados.length} ${diasParados.length > 1 ? 'dias foram' : 'dia foi'} bem mais ${diasParados.length > 1 ? 'parados' : 'parado'} que o normal nas últimas 2 semanas (${nomes}).${diasParados.length >= 3 ? ' Vale observar o apetite e a disposição.' : ''}` });
  }

  return {
    passados, media, desvio, nDias, fonte, aprendendo, limite, faixa, repousoHoje, agora, referencia, statusBpm,
    normalMin, normalDist, pctHoje, hojeParado, diasParados, tendencia, insights: ins
  };
}

// ------------------------------------------------------------ gráficos (SVG desenhado no tamanho real)
function el(tag, attrs = {}, texto) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (texto != null) e.textContent = texto;
  return e;
}
function rotuloDia(data, hojeData) {
  if (data === hojeData) return 'hoje';
  return DIA_SEMANA[paraDate(data).getDay()];
}

export function graficoRepouso(svg, dias, hoje, an) {
  const W = svg.clientWidth, H = svg.clientHeight;
  svg.replaceChildren();
  if (!W || !H) return;
  const lista = [...dias.slice(-13), hoje];
  const pts = lista.map((d) => ({ data: d.data, v: repousoDoDia(d, d.data === hoje.data ? 5 : MIN_MIN_REPOUSO_DIA) }));
  const vals = pts.map((p) => p.v).filter((v) => v != null);
  if (!vals.length) {
    svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'g-vazio' }, 'Sem leituras em repouso ainda'));
    return;
  }
  const pad = { l: 34, r: 10, t: 12, b: 26 };
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (an.faixa) { lo = Math.min(lo, an.faixa[0]); hi = Math.max(hi, an.faixa[1]); }
  lo = Math.floor((lo - 4) / 5) * 5; hi = Math.ceil((hi + 4) / 5) * 5;
  const x = (i) => pad.l + (i + 0.5) * ((W - pad.l - pad.r) / lista.length);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  if (an.faixa && !an.aprendendo) {
    svg.append(el('rect', { x: pad.l, y: y(an.faixa[1]), width: W - pad.l - pad.r, height: y(an.faixa[0]) - y(an.faixa[1]), class: 'g-faixa', rx: 2 }));
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(an.media), y2: y(an.media), class: 'g-media' }));
  }
  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    svg.append(el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'g-eixo' }, v));
  }
  const passo = W < 420 ? 2 : 1;
  pts.forEach((p, i) => {
    if (i % passo === 0 || p.data === hoje.data) svg.append(el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'g-eixo' + (p.data === hoje.data ? ' g-hoje' : '') }, rotuloDia(p.data, hoje.data)));
  });
  let d = '';
  pts.forEach((p, i) => { if (p.v != null) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; });
  svg.append(el('path', { d, class: 'g-linha' }));
  pts.forEach((p, i) => {
    if (p.v == null) return;
    const fora = an.faixa && !an.aprendendo && (p.v > an.faixa[1] || p.v < an.faixa[0]);
    const c = el('circle', { cx: x(i), cy: y(p.v), r: p.data === hoje.data ? 6 : 4, class: 'g-ponto' + (p.data === hoje.data ? ' g-hoje' : '') + (fora ? ' g-fora' : '') });
    c.append(el('title', {}, `${rotuloDia(p.data, hoje.data)}: ${Math.round(p.v)} bpm em repouso`));
    svg.append(c);
  });
}

export function graficoAtividade(svg, dias, hoje, an) {
  const W = svg.clientWidth, H = svg.clientHeight;
  svg.replaceChildren();
  if (!W || !H) return;
  const lista = [...dias.slice(-13), hoje];
  const pad = { l: 34, r: 10, t: 14, b: 26 };
  const maxV = Math.max(30, ...lista.map((d) => d.minutosAtivos || 0), an.normalMin || 0) * 1.12;
  const larg = (W - pad.l - pad.r) / lista.length;
  const y = (v) => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);
  for (const v of [0, Math.round(maxV / 2 / 10) * 10]) {
    svg.append(el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'g-eixo' }, v));
  }
  const passo = W < 420 ? 2 : 1;
  lista.forEach((d, i) => {
    const v = d.minutosAtivos || 0, eHoje = d.data === hoje.data;
    const parado = !eHoje && an.normalMin && v < 0.6 * an.normalMin;
    const r = el('rect', {
      x: pad.l + i * larg + larg * 0.18, y: y(v), width: larg * 0.64, height: Math.max(2, y(0) - y(v)), rx: 1,
      class: 'g-barra' + (eHoje ? ' g-hoje' : '') + (parado ? ' g-parado' : '')
    });
    r.append(el('title', {}, `${rotuloDia(d.data, hoje.data)}: ${v} min ativos, ${((d.distanciaM || 0) / 1000).toFixed(1)} km`));
    svg.append(r);
    if (i % passo === 0 || eHoje) svg.append(el('text', { x: pad.l + i * larg + larg / 2, y: H - 8, 'text-anchor': 'middle', class: 'g-eixo' + (eHoje ? ' g-hoje' : '') }, rotuloDia(d.data, hoje.data)));
  });
  if (an.normalMin) {
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(an.normalMin), y2: y(an.normalMin), class: 'g-media' }));
    svg.append(el('text', { x: pad.l + 4, y: y(an.normalMin) - 6, 'text-anchor': 'start', class: 'g-rotulo' }, `normal ~${Math.round(an.normalMin)} min`));
  }
}
