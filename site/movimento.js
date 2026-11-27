// Movimento que mostra o que mudou: números que contam até o valor novo,
// o pet que anda no mapa em vez de pular, e um destaque curto no que acabou
// de mudar. Quem pediu ao sistema para reduzir animações vê tudo parado.
export const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const facil = (t) => 1 - (1 - t) ** 3;

// conta do número atual até o novo (ex.: 17 m -> 96 m)
export function contar(el, valor, { sufixo = '', ms = 600 } = {}) {
  if (!el) return;
  if (typeof valor !== 'number' || !isFinite(valor)) {
    el.dataset.valor = '';
    el.textContent = valor;
    return;
  }
  const de = el.dataset.valor === undefined || el.dataset.valor === '' ? (el.dataset.primeira ? valor : 0) : Number(el.dataset.valor);
  el.dataset.valor = valor;
  el.dataset.primeira = '1';
  cancelAnimationFrame(el._contador || 0);
  if (semMovimento() || de === valor) { el.textContent = Math.round(valor) + sufixo; return; }
  const ini = performance.now();
  const passo = (agora) => {
    const t = Math.min(1, (agora - ini) / ms);
    el.textContent = Math.round(de + (valor - de) * facil(t)) + sufixo;
    if (t < 1) el._contador = requestAnimationFrame(passo);
  };
  el._contador = requestAnimationFrame(passo);
}

// leva um marcador do Leaflet até a nova posição em vez de teletransportar
export function moverSuave(marcador, [lat, lng], ms = 700) {
  const de = marcador.getLatLng();
  cancelAnimationFrame(marcador._andando || 0);
  const longe = Math.abs(de.lat - lat) > 0.01 || Math.abs(de.lng - lng) > 0.01;   // mais de ~1 km: pula
  if (semMovimento() || longe || (de.lat === lat && de.lng === lng)) { marcador.setLatLng([lat, lng]); return; }
  const ini = performance.now();
  const passo = (agora) => {
    const t = Math.min(1, (agora - ini) / ms);
    const k = facil(t);
    marcador.setLatLng([de.lat + (lat - de.lat) * k, de.lng + (lng - de.lng) * k]);
    if (t < 1) marcador._andando = requestAnimationFrame(passo);
  };
  marcador._andando = requestAnimationFrame(passo);
}

// dispara de novo uma animação de CSS (ex.: .trocou) no elemento
export function destacar(el, classe = 'trocou') {
  if (!el || semMovimento()) return;
  el.classList.remove(classe);
  void el.offsetWidth;            // reinicia a animação
  el.classList.add(classe);
  el.addEventListener('animationend', () => el.classList.remove(classe), { once: true });
}
