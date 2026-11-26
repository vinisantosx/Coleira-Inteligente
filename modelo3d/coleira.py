"""
Coleira inteligente para pet - modelo 3D parametrico (unidades: mm)
Gera STLs imprimiveis + um GLB montado para visualizacao.

Eixos de cada modulo:  X = ao longo da coleira | Y = largura da fita | Z = para fora do pescoco
"""
import math, os, json
import numpy as np
import trimesh
from manifold3d import Manifold, CrossSection, JoinType, set_circular_segments

set_circular_segments(64)
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

# ---------------- parametros ----------------
FOLGA = 0.4             # folga de encaixe
FITA_L = 25.0           # largura da fita de nylon (1")
FITA_E = 2.0            # espessura da fita
FURO_PILOTO = 1.8       # parafuso M2 auto-atarraxante
FURO_PASSANTE = 2.4

# modulo principal: cavidade interna
CAV_X, CAV_Y, CAV_H = 68.0, 33.0, 22.0
PISO = 2.4
CORPO_X, CORPO_Y, RAIO_CANTO = 80.0, 44.0, 7.0
TAMPA_E = 2.4
ABA_C = 10.0            # comprimento das abas com rasgo da fita
RASGO_X, RASGO_Y = 3.6, FITA_L + 2.0
ABA_E = 3.0
ABA_Y = RASGO_Y + 9.0

# modulo sensor (MAX30102)
S_CAV_X, S_CAV_Y, S_CAV_H = 23.0, 18.0, 6.0
S_PISO = 1.2
S_X, S_Y, S_R = 34.0, 29.0, 5.0
S_TAMPA_E = 1.6
JANELA = (9.0, 6.0)


def rrect(w, h, r, height, z0=0.0):
    r = min(r, w / 2 - 0.01, h / 2 - 0.01)
    cs = CrossSection.square([w - 2 * r, h - 2 * r], center=True).offset(r, JoinType.Round)
    return Manifold.extrude(cs, height).translate([0, 0, z0])


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def cyl(r, h, x=0, y=0, z=0, r2=None):
    return Manifold.cylinder(h, r, r if r2 is None else r2).translate([x, y, z])


def abas_fita(comp_corpo, largura, espessura):
    """Abas nas pontas (X) com rasgo para a fita passar por baixo/por cima do modulo."""
    parts = []
    for s in (-1, 1):
        cx = s * (comp_corpo / 2 + ABA_C / 2 - 1.0)
        aba = rrect(ABA_C + 2.0 + 6, largura, 3.0, espessura).translate([cx - s * 3, 0, 0])
        rasgo = rrect(RASGO_X, RASGO_Y, 1.2, espessura + 2, -1).translate([s * (comp_corpo / 2 + ABA_C / 2), 0, 0])
        parts.append(aba - rasgo)
    return parts


def furos_cantos(cx, cy, off):
    return [(sx * (cx / 2 + off), sy * (cy / 2 + off)) for sx in (-1, 1) for sy in (-1, 1)]


# ======================================================
# MODULO PRINCIPAL - BASE
# ======================================================
ALT_CORPO = PISO + CAV_H
base = rrect(CORPO_X, CORPO_Y, RAIO_CANTO, ALT_CORPO)
base = base - box(-CAV_X / 2, CAV_X / 2, -CAV_Y / 2, CAV_Y / 2, PISO, ALT_CORPO + 1)
for a in abas_fita(CORPO_X, ABA_Y, ABA_E):
    base = base + a
    # reabre o rasgo caso a uniao tenha fechado
for s in (-1, 1):
    base = base - rrect(RASGO_X, RASGO_Y, 1.2, ABA_E + 2, -1).translate([s * (CORPO_X / 2 + ABA_C / 2), 0, 0])
base = base - box(-CAV_X / 2, CAV_X / 2, -CAV_Y / 2, CAV_Y / 2, PISO, ALT_CORPO + 1)   # abas nao invadem a cavidade

FUROS_P = furos_cantos(CAV_X, CAV_Y, 2.3)
for (x, y) in FUROS_P:
    base = base - cyl(FURO_PILOTO / 2, 13, x, y, ALT_CORPO - 12.5)

# layout interno (camadas)
BAT = dict(x0=-30, x1=10, y0=-15, y1=15, z0=PISO, z1=PISO + 8)            # LiPo 803040
TP = dict(x0=16, x1=33, y0=-12.5, y1=15.5, z0=PISO, z1=PISO + 5)          # TP4056 USB-C (girado)
CH = dict(x0=-34, x1=-30.4, y0=-4.3, y1=4.3, z0=PISO, z1=PISO + 3.5)      # chave SS12D00
BANDEJA_Z = PISO + 8.3
ESP = dict(x0=-26, x1=26, y0=-14.25, y1=14.25, z0=BANDEJA_Z + 1.2, z1=BANDEJA_Z + 1.2 + 6)
GPS_Z = ESP["z1"] + 0.8
GPS = dict(x0=-34, x1=2, y0=-12.25, y1=12.25, z0=GPS_Z, z1=GPS_Z + 6)
PATCH = dict(x0=9, x1=34, y0=-12.5, y1=12.5, z0=ALT_CORPO - 4.9, z1=ALT_CORPO - 0.7)
LED_X, LED_Y = 5.5, 0.0

# USB-C do carregador (parede +Y) com rebaixo externo
usb_x = (TP["x0"] + TP["x1"]) / 2
usb_z = PISO + 1.6 + 1.7
base = base - rrect(9.6, 4.0, 1.4, 20).rotate([-90, 0, 0]).translate([usb_x, CAV_Y / 2 - 1, usb_z])
base = base - rrect(13.0, 7.5, 3.0, 10).rotate([-90, 0, 0]).translate([usb_x, CORPO_Y / 2 - 3.0, usb_z])

# chave liga/desliga (parede -X) com rebaixo externo
ch_z = PISO + 1.75
base = base - box(-CORPO_X / 2 - 1, -CAV_X / 2 + 0.5, -3.2, 3.2, ch_z - 1.4, ch_z + 1.4)
rebaixo_ch = box(-CORPO_X / 2 - 1, -CAV_X / 2 - 1.5, -6.0, 6.0, ch_z - 3.5, ch_z + 3.5)
base = base - rebaixo_ch

# passagem do cabo do sensor (no piso, entre bateria e carregador)
CABO_X, CABO_Y = 13.0, -10.0
base = base - cyl(2.2, PISO + 2, CABO_X, CABO_Y, -1)

# ======================================================
# MODULO PRINCIPAL - TAMPA
# ======================================================
tampa = rrect(CORPO_X, CORPO_Y, RAIO_CANTO, TAMPA_E)
for (x, y) in FUROS_P:
    tampa = tampa - cyl(FURO_PASSANTE / 2, TAMPA_E + 2, x, y, -1)
    tampa = tampa - cyl(1.2, 1.01, x, y, TAMPA_E - 1.0, r2=2.3)     # escareado
# LED 5 mm: furo + rebaixo inferior para o colar do LED
tampa = tampa - cyl(2.6, TAMPA_E + 2, LED_X, LED_Y, -1)
tampa = tampa - cyl(3.2, 1.0, LED_X, LED_Y, -0.01)
# rebaixo para adesivo QR "Se me achar, ligue" (22 x 22 x 0.6)
QR_X = -17.0
tampa = tampa - rrect(22.4, 22.4, 1.5, 1, TAMPA_E - 0.6).translate([QR_X, 0, 0])
# patinha gravada
PATA_X = 21.5
pata = Manifold.hull(cyl(4.2, 1, PATA_X - 1.5, -2.5, TAMPA_E - 0.6) + cyl(4.2, 1, PATA_X + 1.5, -2.5, TAMPA_E - 0.6)
                     + cyl(3.5, 1, PATA_X, 0.0, TAMPA_E - 0.6))
for (dx, dy, r) in [(-6.2, 3.0, 1.9), (-2.2, 6.2, 2.0), (2.2, 6.2, 2.0), (6.2, 3.0, 1.9)]:
    pata = pata + cyl(r, 1, PATA_X + dx, dy, TAMPA_E - 0.6)
tampa = tampa - pata

# ======================================================
# BANDEJA ISOLANTE (entre bateria e ESP32)
# ======================================================
bandeja = rrect(CAV_X - 1.0, CAV_Y - 1.0, 1.0, 1.2)
bandeja = bandeja - box(10.5, 15.5, -16, -7, -1, 3)   # passagem de fios (lado do cabo)
bandeja = bandeja - box(-33, -29, -6, 6, -1, 3)       # fios da chave
bandeja = bandeja - box(28, 34, -16, -11, -1, 3)

# ======================================================
# MODULO SENSOR (MAX30102) - BASE + TAMPA
# ======================================================
S_ALT = S_PISO + S_CAV_H
sbase = rrect(S_X, S_Y, S_R, S_ALT)
sbase = sbase - box(-S_CAV_X / 2, S_CAV_X / 2, -S_CAV_Y / 2, S_CAV_Y / 2, S_PISO, S_ALT + 1)
for a in abas_fita(S_X, ABA_Y, ABA_E):
    sbase = sbase + a
for s in (-1, 1):
    sbase = sbase - rrect(RASGO_X, RASGO_Y, 1.2, ABA_E + 2, -1).translate([s * (S_X / 2 + ABA_C / 2), 0, 0])
sbase = sbase - box(-S_CAV_X / 2, S_CAV_X / 2, -S_CAV_Y / 2, S_CAV_Y / 2, S_PISO, S_ALT + 1)
# janela optica (sensor encostado na pele)
sbase = sbase - rrect(JANELA[0], JANELA[1], 1.0, S_PISO + 2, -1)
FUROS_S = furos_cantos(S_CAV_X, S_CAV_Y, 2.3)
for (x, y) in FUROS_S:
    sbase = sbase - cyl(FURO_PILOTO / 2, 6.5, x, y, S_ALT - 6.0)
# entrada do cabo (parede +X)
sbase = sbase - cyl(1.9, 10, 0, 0, 0).rotate([0, 90, 0]).translate([S_CAV_X / 2 - 1, 0, S_PISO + 4.0])

stampa = rrect(S_X, S_Y, S_R, S_TAMPA_E)
for (x, y) in FUROS_S:
    stampa = stampa - cyl(FURO_PASSANTE / 2, S_TAMPA_E + 2, x, y, -1)
    stampa = stampa - cyl(1.2, 0.81, x, y, S_TAMPA_E - 0.8, r2=2.1)

# ======================================================
# CLIPE DE CABO (desliza na fita e segura o cabo de 4 vias)
# ======================================================
CL_W = 6.0
anel = rrect(FITA_L + 2 + 3.2, FITA_E + 0.6 + 3.2, 2.0, CL_W) - rrect(FITA_L + 2, FITA_E + 0.6, 0.6, CL_W + 2, -1)
tubo = cyl(3.0, CL_W).translate([0, (FITA_E + 0.6 + 3.2) / 2 + 2.2, 0])
furo_t = cyl(1.75, CL_W + 2).translate([0, (FITA_E + 0.6 + 3.2) / 2 + 2.2, -1])
fenda = box(-1.1, 1.1, (FITA_E + 0.6 + 3.2) / 2 + 2.2, 20, -1, CL_W + 1)
clipe = (anel + tubo) - furo_t - fenda


# ======================================================
# exportacao
# ======================================================
def to_tm(m: Manifold):
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties)[:, :3]
    f = np.asarray(mesh.tri_verts)
    return trimesh.Trimesh(v, f, process=True)


pecas = {
    "01_modulo_principal_base": base,
    "02_modulo_principal_tampa": tampa.mirror([0, 0, 1]).translate([0, 0, TAMPA_E]),   # imprime virada (face lisa na mesa)
    "03_bandeja_isolante": bandeja,
    "04_modulo_sensor_base": sbase,
    "05_modulo_sensor_tampa": stampa.mirror([0, 0, 1]).translate([0, 0, S_TAMPA_E]),
    "06_clipe_cabo_x4": clipe,
}
# a tampa impressa com a face superior para baixo: espelhar inverte a patinha? (espelho em Z mantem o desenho)
info = {}
for nome, m in pecas.items():
    t = to_tm(m)
    t.export(os.path.join(OUT, nome + ".stl"))
    info[nome] = dict(estanque=bool(t.is_watertight), volume_cm3=round(t.volume / 1000, 2),
                      dimensoes_mm=[round(float(d), 1) for d in t.extents])
print(json.dumps(info, indent=1, ensure_ascii=False))
json.dump(info, open(os.path.join(OUT, "pecas.json"), "w"), indent=1, ensure_ascii=False)

# ======================================================
# MONTAGEM PARA VISUALIZACAO (GLB)
# ======================================================
def bx(d, inset=0.0):
    return box(d["x0"] + inset, d["x1"] - inset, d["y0"] + inset, d["y1"] - inset, d["z0"], d["z1"])


comp = {}
comp["bateria"] = rrect(40, 30, 2, 7.6).translate([BAT["x0"] + 20, 0, PISO])
comp["carregador_tp4056"] = box(TP["x0"], TP["x1"], TP["y0"], TP["y1"], PISO, PISO + 1.6) + \
    box(usb_x - 4.5, usb_x + 4.5, TP["y1"] - 7.3, TP["y1"] + 0.3, PISO + 1.6, PISO + 4.8)
comp["chave"] = box(CH["x0"], CH["x1"], CH["y0"], CH["y1"], CH["z0"], CH["z1"]) + \
    box(-CORPO_X / 2 + 2.6, CH["x0"], -0.8, 0.8, ch_z - 0.8, ch_z + 0.8)
comp["bandeja"] = bandeja.translate([0, 0, BANDEJA_Z])
ez = ESP["z0"]
comp["esp32_placa"] = box(-26, 26, -14.25, 14.25, ez, ez + 1.6)
comp["esp32_modulo"] = box(-26, -8, -9, 9, ez + 1.6, ez + 4.8) + box(-25.5, -19, -9, 9, ez + 4.8, ez + 4.81)
comp["esp32_usb"] = box(22, 26.5, -4, 4, ez + 1.6, ez + 4.6)
gz = GPS["z0"]
comp["gps_placa"] = box(GPS["x0"], GPS["x1"], GPS["y0"], GPS["y1"], gz, gz + 1.6)
comp["gps_modulo"] = box(-24, -8, -8, 8, gz + 1.6, gz + 4.0) + cyl(3.0, 3.2, -29, 7, gz + 1.6)
comp["gps_antena"] = box(PATCH["x0"], PATCH["x1"], PATCH["y0"], PATCH["y1"], PATCH["z0"], PATCH["z0"] + 4.0)
comp["gps_antena_topo"] = box(PATCH["x0"] + 4, PATCH["x1"] - 4, -8.5, 8.5, PATCH["z0"] + 4.0, PATCH["z0"] + 4.2) \
    + cyl(1.2, 0.5, 21.5, 0, PATCH["z0"] + 4.2)
comp["led"] = cyl(2.5, 5.6, LED_X, LED_Y, ALT_CORPO - 3.6) + \
    Manifold.sphere(2.5).translate([LED_X, LED_Y, ALT_CORPO + 2.0]) + cyl(2.9, 1.0, LED_X, LED_Y, ALT_CORPO - 4.0)
comp["base"] = base
comp["tampa"] = tampa.translate([0, 0, ALT_CORPO])
comp["etiqueta_qr"] = box(QR_X - 11, QR_X + 11, -11, 11, ALT_CORPO + TAMPA_E - 0.6, ALT_CORPO + TAMPA_E - 0.1)

scomp = {}
scomp["sensor_base"] = sbase
scomp["sensor_tampa"] = stampa.translate([0, 0, S_ALT])
scomp["max30102_placa"] = box(-10.5, 10.5, -8, 8, S_PISO, S_PISO + 1.6)
scomp["max30102_ci"] = box(-2.8, 2.8, -1.65, 1.65, S_PISO - 1.0, S_PISO)

scene = trimesh.Scene()
R_PESCOCO = 62.0     # ~39 cm de circunferencia (cao medio)
R_FITA = R_PESCOCO + 0.0


def place(m: Manifold, ang_deg, raio, nome):
    """Coloca peca no anel: ang=0 topo do pescoco. Z local -> radial pra fora."""
    t = to_tm(m)
    a = math.radians(ang_deg)
    T = np.eye(4)
    # eixos locais: X tangente, Y = eixo do pescoco, Z radial
    radial = np.array([math.sin(a), 0, math.cos(a)])
    tang = np.array([math.cos(a), 0, -math.sin(a)])
    T[:3, 0] = tang
    T[:3, 1] = np.array([0, 1, 0]) if ang_deg == 0 else np.cross(radial, tang)
    T[:3, 2] = radial
    T[:3, 3] = radial * raio
    if abs(np.linalg.det(T[:3, :3]) - 1) > 1e-6:
        T[:3, 1] *= -1
    t.apply_transform(T)
    t.apply_scale(1.0)
    scene.add_geometry(t, node_name=nome, geom_name=nome)


# modulo principal no topo, apoiado sobre a fita
for k, m in comp.items():
    place(m, 0, R_FITA + FITA_E, k)
# modulo sensor embaixo: janela encostada no pescoco, fita por cima da tampa
for k, m in scomp.items():
    place(m, 180, R_PESCOCO - 0.5 - 0.0 + 0.0, k)


def sweep_band(path_fn, n, w, e, y=0.0):
    """Fita: retangulo w (Y) x e (radial) varrido no plano XZ."""
    verts, faces = [], []
    for i in range(n):
        th = 2 * math.pi * i / n
        r = path_fn(th)
        p = np.array([math.sin(th), math.cos(th)])
        for (dy, dr) in [(-w / 2, 0), (w / 2, 0), (w / 2, e), (-w / 2, e)]:
            verts.append([p[0] * (r + dr), y + dy, p[1] * (r + dr)])
    for i in range(n):
        j = (i + 1) % n
        for k in range(4):
            a, b = i * 4 + k, i * 4 + (k + 1) % 4
            c, d = j * 4 + (k + 1) % 4, j * 4 + k
            faces += [[a, b, c], [a, c, d]]
    return trimesh.Trimesh(np.array(verts), np.array(faces), process=True)


S_TOPO = S_ALT + S_TAMPA_E


def raio_fita(th):
    # contorna o modulo principal por baixo (fica sob ele) e o sensor por cima
    d = abs((th - math.pi + math.pi) % (2 * math.pi) - math.pi)  # distancia angular do fundo (pi)
    d_bottom = abs(((th - math.pi) + math.pi) % (2 * math.pi) - math.pi)
    meia = math.atan((S_X / 2 + 2) / R_PESCOCO)
    base_r = R_FITA
    if d_bottom < meia + 0.12:
        s = 1.0 if d_bottom < meia else max(0.0, 1 - (d_bottom - meia) / 0.12)
        s = s * s * (3 - 2 * s)
        return base_r + s * (S_TOPO + 0.5 - (R_FITA - R_PESCOCO + 0.5))
    return base_r


fita = sweep_band(raio_fita, 360, FITA_L, FITA_E)
scene.add_geometry(fita, node_name="fita", geom_name="fita")

# fivela (lateral) e argola D (perto do modulo principal)
fiv = to_tm(rrect(14, FITA_L + 6, 2, 6.0).translate([0, 0, -1]))
place_ang = -100
a = math.radians(place_ang)
T = np.eye(4)
radial = np.array([math.sin(a), 0, math.cos(a)]); tang = np.array([math.cos(a), 0, -math.sin(a)])
T[:3, 0] = tang; T[:3, 2] = radial; T[:3, 1] = np.cross(radial, tang); T[:3, 3] = radial * (R_FITA + 1)
if np.linalg.det(T[:3, :3]) < 0: T[:3, 1] *= -1
fiv.apply_transform(T)
scene.add_geometry(fiv, node_name="fivela", geom_name="fivela")

argola = trimesh.creation.torus(major_radius=11, minor_radius=1.6)
argola.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
a = math.radians(-62)
argola.apply_translation([math.sin(a) * (R_FITA + 9), 0, math.cos(a) * (R_FITA + 9)])
scene.add_geometry(argola, node_name="argola_d", geom_name="argola_d")

# cabo do sensor: corre colado na fita (lado -Y) do topo ate o fundo
pts = []
for i in range(0, 181, 3):
    th = math.radians(10 + i * (160 / 180))
    pts.append([math.sin(th) * (R_FITA + FITA_E + 1.4), -9.0, math.cos(th) * (R_FITA + FITA_E + 1.4)])
pts = np.array(pts)
segs = []
for i in range(len(pts) - 1):
    seg = trimesh.creation.cylinder(radius=1.4, segment=[pts[i], pts[i + 1]], sections=10)
    segs.append(seg)
cabo = trimesh.util.concatenate(segs)
scene.add_geometry(cabo, node_name="cabo", geom_name="cabo")

# clipes do cabo ao longo da fita
for k, ang in enumerate([45, 80, 125, 150]):
    t = to_tm(clipe.translate([0, 0, -CL_W / 2]).rotate([0, -90, 0]).rotate([90, 0, 0]))
    a = math.radians(ang)
    T = np.eye(4)
    radial = np.array([math.sin(a), 0, math.cos(a)]); tang = np.array([math.cos(a), 0, -math.sin(a)])
    T[:3, 0] = tang; T[:3, 2] = radial; T[:3, 1] = np.cross(radial, tang)
    if np.linalg.det(T[:3, :3]) < 0: T[:3, 1] *= -1
    T[:3, 3] = radial * (R_FITA + FITA_E / 2)
    t.apply_transform(T)
    scene.add_geometry(t, node_name=f"clipe_{k}", geom_name=f"clipe_{k}")

scene.export(os.path.join(OUT, "coleira_montada.glb"))
print("GLB ok")

# ---------- checagem de interferencias ----------
if __name__ == "__main__":
    casca = comp["base"] + comp["tampa"]
    nomes = [k for k in comp if k not in ("base", "tampa", "etiqueta_qr")]
    for k in nomes:
        v = (comp[k] ^ casca).volume()
        if v > 0.05: print("COLISAO com carcaca:", k, round(v, 2), "mm3")
    for i, a in enumerate(nomes):
        for b in nomes[i + 1:]:
            v = (comp[a] ^ comp[b]).volume()
            if v > 0.05 and not (a.split('_')[0] == b.split('_')[0]): print("COLISAO:", a, b, round(v, 2))
    for k in ("max30102_placa",):
        v = (scomp[k] ^ (scomp["sensor_base"] + scomp["sensor_tampa"])).volume()
        print("sensor placa x carcaca:", round(v, 2))
    print("checagem concluida")
