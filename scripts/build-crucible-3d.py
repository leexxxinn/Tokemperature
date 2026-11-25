import math
import os
import bpy
import bmesh
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PUBLIC_ASSETS_DIR = os.path.join(ROOT, 'src', 'web', 'public', 'assets')
BLEND_DIR = os.path.join(ROOT, 'assets', 'blender')

os.makedirs(PUBLIC_ASSETS_DIR, exist_ok=True)
os.makedirs(BLEND_DIR, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def set_bsdf(bsdf, name, value):
    if bsdf and name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def ensure_collection(name):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def link_obj(obj, col):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    col.objects.link(obj)
    return obj


def shade_smooth_with_bevel(obj, bevel_width=0.012, segments=2):
    for poly in obj.data.polygons:
        poly.use_smooth = True
    if bevel_width > 0:
        bev = obj.modifiers.new(name='Bevel', type='BEVEL')
        bev.width = bevel_width
        bev.segments = segments
        bev.limit_method = 'ANGLE'
        bev.angle_limit = math.radians(34)


def add_procedural_bump(mat, scale=18.0, detail=7.0, strength=0.10):
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    tex = nt.nodes.new('ShaderNodeTexCoord')
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = detail
    noise.inputs['Roughness'].default_value = 0.62
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = 0.015
    nt.links.new(tex.outputs['Object'], noise.inputs['Vector'])
    nt.links.new(noise.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])


def make_materials():
    # Heavy forged cast iron
    mat_iron = bpy.data.materials.new('CastIron')
    bsdf = mat_iron.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.048, 0.042, 0.044, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.90)
    set_bsdf(bsdf, 'Roughness', 0.42)
    set_bsdf(bsdf, 'Coat Weight', 0.12)
    set_bsdf(bsdf, 'Coat Roughness', 0.36)
    add_procedural_bump(mat_iron, scale=16.0, detail=7.0, strength=0.12)

    # Oxidized dark red copper
    mat_copper = bpy.data.materials.new('AgedCopper')
    bsdf = mat_copper.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.46, 0.19, 0.10, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.93)
    set_bsdf(bsdf, 'Roughness', 0.32)
    add_procedural_bump(mat_copper, scale=22.0, detail=5.0, strength=0.07)

    # Burnished industrial brass
    mat_brass = bpy.data.materials.new('BurnishedBrass')
    bsdf = mat_brass.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.58, 0.40, 0.16, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.94)
    set_bsdf(bsdf, 'Roughness', 0.25)

    # Machined dark gunmetal steel
    mat_steel = bpy.data.materials.new('DarkSteel')
    bsdf = mat_steel.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.095, 0.088, 0.092, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.92)
    set_bsdf(bsdf, 'Roughness', 0.29)

    # Heat-resistant transparent quartz chamber
    mat_quartz = bpy.data.materials.new('QuartzGlass')
    bsdf = mat_quartz.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.90, 0.95, 1.0, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.0)
    set_bsdf(bsdf, 'Roughness', 0.06)
    set_bsdf(bsdf, 'IOR', 1.46)
    set_bsdf(bsdf, 'Transmission Weight', 0.92)
    set_bsdf(bsdf, 'Alpha', 0.22)
    mat_quartz.blend_method = 'BLEND'

    # Molten hearth bed
    mat_lava = bpy.data.materials.new('HearthLava')
    bsdf = mat_lava.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.04, 0.02, 0.015, 1.0))
    set_bsdf(bsdf, 'Roughness', 0.62)
    set_bsdf(bsdf, 'Emission Color', (1.0, 0.34, 0.05, 1.0))
    set_bsdf(bsdf, 'Emission Strength', 6.0)

    # Enamel dial face
    mat_dial = bpy.data.materials.new('DialEnamel')
    bsdf = mat_dial.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.02, 0.018, 0.02, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.05)
    set_bsdf(bsdf, 'Roughness', 0.48)
    set_bsdf(bsdf, 'Emission Color', (0.18, 0.10, 0.05, 1.0))
    set_bsdf(bsdf, 'Emission Strength', 0.25)

    # Neutral emissive accent material (cloned/animated in Three.js)
    mat_emissive = bpy.data.materials.new('EmissiveAccent')
    bsdf = mat_emissive.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.08, 0.06, 0.05, 1.0))
    set_bsdf(bsdf, 'Roughness', 0.25)
    set_bsdf(bsdf, 'Emission Color', (1.0, 0.48, 0.14, 1.0))
    set_bsdf(bsdf, 'Emission Strength', 3.5)

    # Translucent conduit fuel glass
    mat_conduit = bpy.data.materials.new('ConduitGlass')
    bsdf = mat_conduit.node_tree.nodes.get('Principled BSDF')
    set_bsdf(bsdf, 'Base Color', (0.95, 0.50, 0.22, 1.0))
    set_bsdf(bsdf, 'Metallic', 0.05)
    set_bsdf(bsdf, 'Roughness', 0.18)
    set_bsdf(bsdf, 'Emission Color', (1.0, 0.42, 0.10, 1.0))
    set_bsdf(bsdf, 'Emission Strength', 2.4)

    return {
        'iron': mat_iron,
        'copper': mat_copper,
        'brass': mat_brass,
        'steel': mat_steel,
        'quartz': mat_quartz,
        'lava': mat_lava,
        'dial': mat_dial,
        'emissive': mat_emissive,
        'conduit': mat_conduit,
    }


def build_cylinder(name, radius, depth, loc, vertices, col, mat, bevel=0.012, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    link_obj(obj, col)
    obj.data.materials.append(mat)
    shade_smooth_with_bevel(obj, bevel_width=bevel, segments=2)
    if parent:
        obj.parent = parent
    return obj


def build_box(name, size, loc, col, mat, bevel=0.010, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    shade_smooth_with_bevel(obj, bevel_width=bevel, segments=2)
    if parent:
        obj.parent = parent
    return obj


def build_cone_frustum(name, r1, r2, depth, loc, vertices, col, mat, bevel=0.012, parent=None):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r1, radius2=r2, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    link_obj(obj, col)
    obj.data.materials.append(mat)
    shade_smooth_with_bevel(obj, bevel_width=bevel, segments=2)
    if parent:
        obj.parent = parent
    return obj


def build_annular_shell(name, r_in, r_out, z0, z1, angle_start_deg, angle_end_deg, steps, col, mat, bevel=0.010, parent=None):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    a0 = math.radians(angle_start_deg)
    a1 = math.radians(angle_end_deg)
    is_full = abs((angle_end_deg - angle_start_deg) - 360.0) <= 1e-3
    ring_verts = []
    count = steps if is_full else steps + 1
    for i in range(count):
        t = i / steps
        a = a0 + (a1 - a0) * t
        ca, sa = math.cos(a), math.sin(a)
        v_in_bot = bm.verts.new((r_in * ca, r_in * sa, z0))
        v_out_bot = bm.verts.new((r_out * ca, r_out * sa, z0))
        v_out_top = bm.verts.new((r_out * ca, r_out * sa, z1))
        v_in_top = bm.verts.new((r_in * ca, r_in * sa, z1))
        ring_verts.append((v_in_bot, v_out_bot, v_out_top, v_in_top))

    seg_count = steps if is_full else steps
    for i in range(seg_count):
        ni = (i + 1) % len(ring_verts) if is_full else i + 1
        a_ib, a_ob, a_ot, a_it = ring_verts[i]
        b_ib, b_ob, b_ot, b_it = ring_verts[ni]
        bm.faces.new((a_ib, b_ib, b_ob, a_ob))
        bm.faces.new((a_ob, b_ob, b_ot, a_ot))
        bm.faces.new((a_ot, b_ot, b_it, a_it))
        bm.faces.new((a_it, b_it, b_ib, a_ib))

    if not is_full:
        bm.faces.new(ring_verts[0][::-1])
        bm.faces.new(ring_verts[-1])

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    shade_smooth_with_bevel(obj, bevel_width=bevel, segments=2)
    if parent:
        obj.parent = parent
    return obj


def build_quartz_chamber(name, r_end, r_mid, z0, z1, seg_u, seg_v, col, mat):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    rings = []
    for iv in range(seg_v + 1):
        tv = iv / seg_v
        z = z0 + (z1 - z0) * tv
        bulge = math.sin(tv * math.pi)
        r = r_end + (r_mid - r_end) * bulge
        row = []
        for iu in range(seg_u):
            tu = iu / seg_u
            a = 2.0 * math.pi * tu
            row.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        rings.append(row)

    for iv in range(seg_v):
        v0 = iv / seg_v
        v1 = (iv + 1) / seg_v
        for iu in range(seg_u):
            ni = (iu + 1) % seg_u
            u0 = iu / seg_u
            u1 = (iu + 1) / seg_u
            f = bm.faces.new((rings[iv][iu], rings[iv][ni], rings[iv + 1][ni], rings[iv + 1][iu]))
            uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = uv

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def build_hearth_disk(name, radius, z_base, z_dome, rings, segs, col, mat):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()

    center = bm.verts.new((0.0, 0.0, z_base + z_dome))
    ring_verts = []
    for ir in range(1, rings + 1):
        fr = ir / rings
        r = radius * fr
        z = z_base + z_dome * (1.0 - fr * fr)
        row = []
        for iseg in range(segs):
            a = 2.0 * math.pi * iseg / segs
            row.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        ring_verts.append(row)

    def uv_of(v):
        return (0.5 + 0.5 * (v.co.x / radius), 0.5 + 0.5 * (v.co.y / radius))

    for iseg in range(segs):
        ni = (iseg + 1) % segs
        f = bm.faces.new((center, ring_verts[0][iseg], ring_verts[0][ni]))
        for loop in f.loops:
            loop[uv_layer].uv = uv_of(loop.vert)

    for ir in range(rings - 1):
        for iseg in range(segs):
            ni = (iseg + 1) % segs
            f = bm.faces.new((
                ring_verts[ir][iseg],
                ring_verts[ir + 1][iseg],
                ring_verts[ir + 1][ni],
                ring_verts[ir][ni],
            ))
            for loop in f.loops:
                loop[uv_layer].uv = uv_of(loop.vert)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def bezier_point(p0, p1, p2, p3, t):
    u = 1.0 - t
    return (
        p0 * (u ** 3)
        + p1 * (3.0 * (u ** 2) * t)
        + p2 * (3.0 * u * (t ** 2))
        + p3 * (t ** 3)
    )


def bezier_tangent(p0, p1, p2, p3, t):
    u = 1.0 - t
    return (
        (p1 - p0) * (3.0 * (u ** 2))
        + (p2 - p1) * (6.0 * u * t)
        + (p3 - p2) * (3.0 * (t ** 2))
    ).normalized()


def build_conduit_tube(name, p0, p1, p2, p3, radius, segs_u, segs_v, col, mat):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    rings = []
    up_hint = Vector((0.0, 0.0, 1.0))

    for iu in range(segs_u + 1):
        t = iu / segs_u
        center = bezier_point(p0, p1, p2, p3, t)
        tang = bezier_tangent(p0, p1, p2, p3, t)
        if abs(tang.dot(up_hint)) > 0.96:
            up_hint = Vector((1.0, 0.0, 0.0))
        binorm = tang.cross(up_hint).normalized()
        norm = binorm.cross(tang).normalized()
        row = []
        for iv in range(segs_v):
            a = 2.0 * math.pi * iv / segs_v
            pt = center + (norm * math.cos(a) + binorm * math.sin(a)) * radius
            row.append(bm.verts.new(pt))
        rings.append(row)

    for iu in range(segs_u):
        u0 = iu / segs_u
        u1 = (iu + 1) / segs_u
        for iv in range(segs_v):
            nv = (iv + 1) % segs_v
            v0 = iv / segs_v
            v1 = (iv + 1) / segs_v
            f = bm.faces.new((rings[iu][iv], rings[iu + 1][iv], rings[iu + 1][nv], rings[iu][nv]))
            for loop, uv in zip(f.loops, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]):
                loop[uv_layer].uv = uv

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def build_vent_petal_mesh(name, col, mat):
    """Build a curved trapezoidal exhaust petal extending from local origin along +Z and slightly +Y."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    # Local space: X tangent, Y radially inward, Z upward
    pts_inner = [
        (-0.24, 0.00, 0.00),
        (0.24, 0.00, 0.00),
        (0.16, 0.14, 0.40),
        (-0.16, 0.14, 0.40),
    ]
    pts_outer = [
        (-0.26, -0.05, -0.01),
        (0.26, -0.05, -0.01),
        (0.18, 0.09, 0.41),
        (-0.18, 0.09, 0.41),
    ]
    vi = [bm.verts.new(p) for p in pts_inner]
    vo = [bm.verts.new(p) for p in pts_outer]
    bm.faces.new((vi[0], vi[1], vi[2], vi[3]))
    bm.faces.new((vo[3], vo[2], vo[1], vo[0]))
    for k in range(4):
        kn = (k + 1) % 4
        bm.faces.new((vi[k], vo[k], vo[kn], vi[kn]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    obj.data.materials.append(mat)
    shade_smooth_with_bevel(obj, bevel_width=0.008, segments=2)
    return obj


def build_scene():
    clear_scene()
    col = ensure_collection('Crucible')
    mats = make_materials()

    # =========================================================================
    # 1. Stepped Forged Foundry Plinth & Boil Progress Ring
    # =========================================================================
    plinth_root = bpy.data.objects.new('CrucibleBase', None)
    link_obj(plinth_root, col)

    build_cylinder('PlinthLower', 1.56, 0.20, (0, 0, 0.10), 12, col, mats['iron'], bevel=0.022, rot=(0, 0, math.pi / 12), parent=plinth_root)
    build_annular_shell('CacheHaloRing', 1.38, 1.44, 0.195, 0.215, 0.0, 360.0, 48, col, mats['emissive'], bevel=0.002, parent=plinth_root)
    build_cylinder('PlinthDeck', 1.32, 0.24, (0, 0, 0.32), 12, col, mats['iron'], bevel=0.018, rot=(0, 0, math.pi / 12), parent=plinth_root)
    build_annular_shell('PlinthDeckTrim', 1.28, 1.35, 0.405, 0.445, 0.0, 360.0, 36, col, mats['copper'], bevel=0.006, parent=plinth_root)

    # 4 heavy buttress feet + copper shoulder lugs + brass perimeter bolts
    for idx, deg in enumerate([45, 135, 225, 315]):
        ang = math.radians(deg)
        fx = 1.48 * math.cos(ang)
        fy = 1.48 * math.sin(ang)
        build_box(f'ButtressFoot_{idx}', (0.34, 0.26, 0.34), (fx, fy, 0.17), col, mats['iron'], bevel=0.016, rot=(0, 0, ang), parent=plinth_root)
        lx = 1.37 * math.cos(ang)
        ly = 1.37 * math.sin(ang)
        build_box(f'ButtressCap_{idx}', (0.20, 0.22, 0.08), (lx, ly, 0.35), col, mats['copper'], bevel=0.008, rot=(0, 0, ang), parent=plinth_root)

    for i in range(12):
        ang = 2.0 * math.pi * i / 12.0
        bx = 1.48 * math.cos(ang)
        by = 1.48 * math.sin(ang)
        build_cylinder(f'PlinthBolt_{i}', 0.032, 0.036, (bx, by, 0.21), 6, col, mats['brass'], bevel=0.004, parent=plinth_root)

    # Boil progress bezel & 24 segments starting front-center (-90 deg) sweeping CCW
    build_annular_shell('BoilBezel', 1.15, 1.27, 0.432, 0.458, 0.0, 360.0, 48, col, mats['steel'], bevel=0.004, parent=plinth_root)
    for i in range(24):
        a0 = -90.0 + i * 15.0 + 1.6
        a1 = -90.0 + (i + 1) * 15.0 - 1.6
        build_annular_shell(f'BoilSeg_{i}', 1.17, 1.25, 0.452, 0.478, a0, a1, 4, col, mats['emissive'], bevel=0.003, parent=plinth_root)

    # Lower riveted chamber collar (Z = 0.44 .. 0.88)
    build_annular_shell('LowerChamberCollar', 0.78, 1.02, 0.44, 0.88, 0.0, 360.0, 36, col, mats['iron'], bevel=0.014)
    build_annular_shell('LowerFlangeBot', 1.00, 1.08, 0.46, 0.54, 0.0, 360.0, 36, col, mats['copper'], bevel=0.008)
    build_annular_shell('LowerFlangeTop', 0.94, 1.06, 0.78, 0.87, 0.0, 360.0, 36, col, mats['copper'], bevel=0.008)
    for i in range(16):
        ang = 2.0 * math.pi * i / 16.0
        rx = 1.065 * math.cos(ang)
        ry = 1.065 * math.sin(ang)
        build_cylinder(f'LowerRivet_{i}', 0.022, 0.028, (rx, ry, 0.825), 6, col, mats['brass'], bevel=0.003, rot=(0, math.pi / 2, ang))

    # =========================================================================
    # 2. Four Curved Fuel Intake Conduits (front-L, front-R, back-L, back-R)
    # =========================================================================
    conduit_angles = [-132.0, -52.0, 132.0, 52.0]
    for idx, deg in enumerate(conduit_angles):
        ang = math.radians(deg)
        ca, sa = math.cos(ang), math.sin(ang)
        rad_dir = Vector((ca, sa, 0.0))

        # Plinth terminal block + glowing status lamp
        term_pos = rad_dir * 1.42 + Vector((0, 0, 0.27))
        build_box(f'ConduitTerm_{idx}', (0.24, 0.22, 0.16), term_pos, col, mats['iron'], bevel=0.012, rot=(0, 0, ang))
        build_box(f'ConduitTermCap_{idx}', (0.18, 0.24, 0.05), term_pos + Vector((0, 0, 0.09)), col, mats['copper'], bevel=0.006, rot=(0, 0, ang))
        lamp_pos = rad_dir * 1.48 + Vector((0, 0, 0.345))
        build_cylinder(f'ConduitLamp_{idx}', 0.042, 0.036, lamp_pos, 12, col, mats['emissive'], bevel=0.004)

        # Intake port on lower collar
        port_pos = rad_dir * 1.00 + Vector((0, 0, 0.64))
        build_cylinder(f'ConduitPort_{idx}', 0.095, 0.12, port_pos, 14, col, mats['copper'], bevel=0.008, rot=(0, math.pi / 2, ang))

        # Smooth curved tube with UV u: 0->1 from plinth terminal into chamber collar
        p0 = rad_dir * 1.38 + Vector((0, 0, 0.32))
        p1 = rad_dir * 1.34 + Vector((0, 0, 0.56))
        p2 = rad_dir * 1.14 + Vector((0, 0, 0.64))
        p3 = rad_dir * 0.96 + Vector((0, 0, 0.64))
        build_conduit_tube(f'ConduitTube_{idx}', p0, p1, p2, p3, 0.052, 20, 14, col, mats['conduit'])

        # Copper clamp rings along tube
        for ci, t in enumerate([0.22, 0.52, 0.80]):
            pt = bezier_point(p0, p1, p2, p3, t)
            tang = bezier_tangent(p0, p1, p2, p3, t)
            clamp_rot = tang.to_track_quat('Z', 'Y').to_euler()
            build_cylinder(f'ConduitClamp_{idx}_{ci}', 0.072, 0.042, pt, 14, col, mats['copper'], bevel=0.005, rot=clamp_rot)

    # =========================================================================
    # 3. Hearth Molten Bed & Cast-Iron Grate
    # =========================================================================
    build_hearth_disk('HearthBed', 0.77, 0.77, 0.06, 8, 36, col, mats['lava'])
    grate_group = build_annular_shell('HearthGrateRim', 0.62, 0.72, 0.82, 0.86, 0.0, 360.0, 24, col, mats['steel'], bevel=0.005)
    # Radial and inner grate ribs joined as single mesh object 'HearthGrate'
    grate_parts = [grate_group]
    grate_parts.append(build_annular_shell('HearthGrateMid', 0.30, 0.37, 0.82, 0.86, 0.0, 360.0, 20, col, mats['steel'], bevel=0.004))
    for gi in range(6):
        ga = math.pi * gi / 6.0
        grate_parts.append(build_box(f'HearthBar_{gi}', (1.36, 0.045, 0.038), (0, 0, 0.84), col, mats['steel'], bevel=0.004, rot=(0, 0, ga)))
    bpy.ops.object.select_all(action='DESELECT')
    for gp in grate_parts:
        gp.select_set(True)
    bpy.context.view_layer.objects.active = grate_parts[0]
    bpy.ops.object.join()
    hearth_grate = bpy.context.active_object
    hearth_grate.name = 'HearthGrate'

    # =========================================================================
    # 4. Quartz Reaction Chamber & Heavy Forged Rib Cage (Z = 0.84 .. 2.84)
    # =========================================================================
    build_quartz_chamber('QuartzShell', 0.75, 0.80, 0.84, 2.82, 48, 20, col, mats['quartz'])

    # 4 diagonal pillars at ±42°, ±138° leaving wide unobstructed front viewing window
    for idx, deg in enumerate([-138.0, -42.0, 42.0, 138.0]):
        ang = math.radians(deg)
        ca, sa = math.cos(ang), math.sin(ang)
        px = 0.85 * ca
        py = 0.85 * sa
        build_box(f'Pillar_{idx}', (0.14, 0.14, 2.02), (px, py, 1.84), col, mats['iron'], bevel=0.014, rot=(0, 0, ang))
        # Oxidized copper cooling fins along pillar outer face
        for fi in range(8):
            fz = 1.02 + fi * 0.23
            fx = 0.90 * ca
            fy = 0.90 * sa
            build_box(f'PillarFin_{idx}_{fi}', (0.12, 0.18, 0.042), (fx, fy, fz), col, mats['copper'], bevel=0.005, rot=(0, 0, ang))
        # Top & bottom brass end brackets
        for cap_z, cap_n in [(0.89, 'Bot'), (2.78, 'Top')]:
            build_box(f'PillarCap{cap_n}_{idx}', (0.18, 0.17, 0.08), (0.87 * ca, 0.87 * sa, cap_z), col, mats['brass'], bevel=0.008, rot=(0, 0, ang))

    # Upper chamber riveted collar (Z = 2.76 .. 2.94)
    build_annular_shell('UpperChamberCollar', 0.74, 1.03, 2.76, 2.92, 0.0, 360.0, 36, col, mats['iron'], bevel=0.012)
    build_annular_shell('UpperFlangeBot', 0.92, 1.06, 2.75, 2.82, 0.0, 360.0, 36, col, mats['copper'], bevel=0.006)
    for i in range(16):
        ang = 2.0 * math.pi * i / 16.0
        rx = 1.04 * math.cos(ang)
        ry = 1.04 * math.sin(ang)
        build_cylinder(f'UpperRivet_{i}', 0.020, 0.026, (rx, ry, 2.84), 6, col, mats['brass'], bevel=0.003, rot=(0, math.pi / 2, ang))

    # =========================================================================
    # 5. Side Steam-Blower Turbines (Z = 0.96, X = ±1.06)
    # =========================================================================
    for side, sx, rot_y in [('L', -1.05, -math.pi / 2), ('R', 1.05, math.pi / 2)]:
        piv = bpy.data.objects.new(f'TurbinePivot_{side}', None)
        piv.location = (sx, 0.0, 0.96)
        piv.rotation_euler = (0.0, rot_y, 0.0)
        link_obj(piv, col)

        build_annular_shell(f'TurbineShroud_{side}', 0.13, 0.165, -0.05, 0.06, 0.0, 360.0, 20, col, mats['copper'], bevel=0.006, parent=piv)
        build_cylinder(f'TurbineMount_{side}', 0.11, 0.16, (0, 0, -0.09), 16, col, mats['iron'], bevel=0.008, parent=piv)

        rotor_piv = bpy.data.objects.new(f'TurbineRotor_{side}', None)
        rotor_piv.location = (0, 0, 0.01)
        link_obj(rotor_piv, col)
        rotor_piv.parent = piv
        build_cylinder(f'TurbineHub_{side}', 0.045, 0.055, (0, 0, 0), 12, col, mats['brass'], bevel=0.004, parent=rotor_piv)
        for bi in range(8):
            ba = 2.0 * math.pi * bi / 8.0
            bx = 0.082 * math.cos(ba)
            by = 0.082 * math.sin(ba)
            build_box(f'TurbineBlade_{side}_{bi}', (0.075, 0.016, 0.044), (bx, by, 0.0), col, mats['brass'], bevel=0.002, rot=(0.35, 0.0, ba), parent=rotor_piv)

    # =========================================================================
    # 6. Front-Right Precision Brass Analog Dial (at -20 deg, Z = 0.86)
    # =========================================================================
    cam_pos = Vector((1.88, -6.55, 2.75))
    dial_ang = math.radians(-20.0)  # -20 deg from -Y toward +X
    gauge_pos = Vector((1.10 * math.sin(-dial_ang), -1.10 * math.cos(-dial_ang), 0.86))
    gauge_dir = (cam_pos - gauge_pos).normalized()
    gauge_rot = gauge_dir.to_track_quat('Z', 'Y').to_euler()

    build_cylinder('GaugeNeck', 0.12, 0.18, gauge_pos - gauge_dir * 0.08, 16, col, mats['iron'], bevel=0.006, rot=gauge_rot)
    build_cylinder('GaugeCasing', 0.21, 0.08, gauge_pos, 28, col, mats['copper'], bevel=0.012, rot=gauge_rot)
    build_cylinder('GaugeBezel', 0.195, 0.025, gauge_pos + gauge_dir * 0.042, 28, col, mats['brass'], bevel=0.005, rot=gauge_rot)
    build_cylinder('GaugeFace', 0.165, 0.015, gauge_pos + gauge_dir * 0.045, 28, col, mats['dial'], bevel=0.002, rot=gauge_rot)

    # 9 raised 3D brass tick marks spanning 240 deg (-120..+120 deg from top)
    ticks_root = bpy.data.objects.new('GaugeTicks', None)
    ticks_root.location = gauge_pos + gauge_dir * 0.054
    ticks_root.rotation_euler = gauge_rot
    link_obj(ticks_root, col)
    for ti in range(9):
        ta = math.radians(-120.0 + ti * 30.0)
        tx = 0.132 * math.sin(ta)
        ty = 0.132 * math.cos(ta)
        t_size = (0.012, 0.028, 0.006) if ti % 2 == 0 else (0.008, 0.020, 0.005)
        build_box(f'GaugeTick_{ti}', t_size, (tx, ty, 0.0), col, mats['brass'], bevel=0.001, rot=(0, 0, -ta), parent=ticks_root)

    needle_pivot = bpy.data.objects.new('GaugeNeedlePivot', None)
    needle_pivot.location = gauge_pos + gauge_dir * 0.060
    needle_pivot.rotation_euler = gauge_rot
    link_obj(needle_pivot, col)
    build_cylinder('GaugeCenterCap', 0.022, 0.014, (0, 0, 0), 12, col, mats['brass'], bevel=0.002, parent=needle_pivot)
    build_box('GaugeNeedle', (0.015, 0.118, 0.008), (0.0, 0.046, 0.0), col, mats['copper'], bevel=0.002, parent=needle_pivot)

    # =========================================================================
    # 7. Dual Counter-Rotating Thermal Gyro Rings (Origin at 0, 0, 1.84)
    # =========================================================================
    ring_inner = bpy.data.objects.new('RingInner', None)
    ring_inner.location = (0.0, 0.0, 1.84)
    link_obj(ring_inner, col)
    build_annular_shell('RingInnerBody', 0.97, 1.05, -0.045, 0.045, 0.0, 360.0, 48, col, mats['iron'], bevel=0.008, parent=ring_inner)
    build_annular_shell('RingInnerGlow', 0.965, 0.985, -0.015, 0.015, 0.0, 360.0, 48, col, mats['emissive'], bevel=0.002, parent=ring_inner)
    for li in range(8):
        la = 2.0 * math.pi * li / 8.0
        build_box(f'RingInnerLug_{li}', (0.06, 0.09, 0.115), (1.055 * math.cos(la), 1.055 * math.sin(la), 0.0), col, mats['copper'], bevel=0.006, rot=(0, 0, la), parent=ring_inner)

    ring_outer = bpy.data.objects.new('RingOuter', None)
    ring_outer.location = (0.0, 0.0, 1.84)
    link_obj(ring_outer, col)
    build_annular_shell('RingOuterBody', 1.13, 1.21, -0.050, 0.050, 0.0, 360.0, 48, col, mats['copper'], bevel=0.009, parent=ring_outer)
    build_annular_shell('RingOuterGlow', 1.125, 1.142, -0.016, 0.016, 0.0, 360.0, 48, col, mats['emissive'], bevel=0.002, parent=ring_outer)
    for bi in range(4):
        ba = 2.0 * math.pi * bi / 4.0 + math.pi / 4.0
        build_box(f'RingOuterBracket_{bi}', (0.075, 0.12, 0.13), (1.215 * math.cos(ba), 1.215 * math.sin(ba), 0.0), col, mats['brass'], bevel=0.006, rot=(0, 0, ba), parent=ring_outer)

    # =========================================================================
    # 8. Thermal Crown & 6 Articulated Exhaust Vent Petals (Z = 2.88 .. 3.68)
    # =========================================================================
    build_cone_frustum('ThermalCrownHood', 1.00, 0.64, 0.36, (0, 0, 3.06), 48, col, mats['iron'], bevel=0.014)
    build_annular_shell('CrownArmorBand', 0.61, 0.68, 3.16, 3.25, 0.0, 360.0, 32, col, mats['copper'], bevel=0.008)
    build_annular_shell('CrownInnerGlow', 0.38, 0.45, 2.88, 3.30, 0.0, 360.0, 32, col, mats['emissive'], bevel=0.003)

    # 6 articulated petals hinged around r=0.58, Z=3.22
    for vi in range(6):
        ang = 2.0 * math.pi * vi / 6.0 + math.radians(30.0)
        ca, sa = math.cos(ang), math.sin(ang)
        vp = bpy.data.objects.new(f'VentPivot_{vi}', None)
        vp.location = (0.58 * ca, 0.58 * sa, 3.22)
        # Local X tangent (-sa, ca, 0), local Y inward (-ca, -sa, 0), local Z up (0, 0, 1)
        rot_mat = Matrix((
            (-sa, -ca, 0.0),
            (ca, -sa, 0.0),
            (0.0, 0.0, 1.0),
        )).to_4x4()
        vp.rotation_euler = rot_mat.to_euler()
        link_obj(vp, col)
        petal = build_vent_petal_mesh(f'VentFlap_{vi}', col, mats['iron'])
        petal.parent = vp
        build_box(f'VentTrim_{vi}', (0.34, 0.04, 0.06), (0.0, 0.03, 0.22), col, mats['copper'], bevel=0.004, parent=vp)

    # Top protective crown ring supported by 3 slender struts
    build_annular_shell('CrownTopGuard', 0.54, 0.61, 3.58, 3.66, 0.0, 360.0, 32, col, mats['copper'], bevel=0.008)
    for si in range(3):
        sa_ang = 2.0 * math.pi * si / 3.0
        build_box(f'CrownStrut_{si}', (0.055, 0.055, 0.40), (0.61 * math.cos(sa_ang), 0.61 * math.sin(sa_ang), 3.41), col, mats['iron'], bevel=0.006, rot=(0, 0, sa_ang))

    # =========================================================================
    # 9. Named Anchor Empties for Three.js Shaders & Particles
    # =========================================================================
    for aname, aloc in [
        ('FireVolumeAnchor', (0.0, 0.0, 1.84)),
        ('ExhaustAnchor', (0.0, 0.0, 3.28)),
        ('HearthAnchor', (0.0, 0.0, 0.82)),
    ]:
        anchor = bpy.data.objects.new(aname, None)
        anchor.location = aloc
        link_obj(anchor, col)

    # Save clean editable .blend & export pure GLB (excluding lights/camera)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND_DIR, 'tokemperature-crucible.blend'))

    bpy.ops.object.select_all(action='DESELECT')
    for obj in col.objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(PUBLIC_ASSETS_DIR, 'crucible-reactor.glb'),
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
    )

    # =========================================================================
    # 10. Cycles Fallback PNG Render (hot state preview for non-WebGL fallback)
    # =========================================================================
    studio_col = ensure_collection('FallbackStudio')

    # Add glowing inner preview fire cone for fallback PNG
    mat_preview_fire = bpy.data.materials.new('PreviewFire')
    nt = mat_preview_fire.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    mix = nt.nodes.new('ShaderNodeMixShader')
    transp = nt.nodes.new('ShaderNodeBsdfTransparent')
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 14.0
    tex = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    cr = nt.nodes.new('ShaderNodeValToRGB')
    cr.color_ramp.elements[0].position = 0.08
    cr.color_ramp.elements[0].color = (1.0, 0.78, 0.25, 1.0)
    cr.color_ramp.elements[1].position = 0.85
    cr.color_ramp.elements[1].color = (1.0, 0.16, 0.02, 1.0)
    ar = nt.nodes.new('ShaderNodeValToRGB')
    ar.color_ramp.elements[0].position = 0.1
    ar.color_ramp.elements[0].color = (0.9, 0.9, 0.9, 1.0)
    ar.color_ramp.elements[1].position = 0.95
    ar.color_ramp.elements[1].color = (0.05, 0.05, 0.05, 1.0)
    nt.links.new(tex.outputs['Generated'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Z'], cr.inputs['Fac'])
    nt.links.new(sep.outputs['Z'], ar.inputs['Fac'])
    nt.links.new(cr.outputs['Color'], emit.inputs['Color'])
    nt.links.new(ar.outputs['Color'], mix.inputs['Fac'])
    nt.links.new(transp.outputs['BSDF'], mix.inputs[1])
    nt.links.new(emit.outputs['Emission'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])

    build_cone_frustum('PreviewFlameOuter', 0.44, 0.06, 1.55, (0, 0, 1.62), 20, studio_col, mat_preview_fire, bevel=0.0)
    build_cone_frustum('PreviewFlameCore', 0.25, 0.03, 1.15, (0, 0, 1.44), 16, studio_col, mat_preview_fire, bevel=0.0)

    # Tilt gyro rings & open vent petals slightly for dynamic silhouette in fallback PNG
    ring_inner.rotation_euler = (math.radians(14), math.radians(-10), 0.0)
    ring_outer.rotation_euler = (math.radians(-18), math.radians(16), 0.0)
    for vi in range(6):
        bpy.data.objects[f'VentPivot_{vi}'].rotation_euler.rotate_axis('X', math.radians(22))
    needle_pivot.rotation_euler.rotate_axis('Z', math.radians(-10))

    def add_light(name, ltype, loc, energy, color, size=1.0, rot=(0, 0, 0)):
        ldata = bpy.data.lights.new(name=name, type=ltype)
        ldata.energy = energy
        ldata.color = color
        if ltype == 'POINT':
            ldata.shadow_soft_size = size
        elif ltype == 'AREA':
            ldata.size = size
        lobj = bpy.data.objects.new(name=name, object_data=ldata)
        lobj.location = loc
        lobj.rotation_euler = rot
        link_obj(lobj, studio_col)
        return lobj

    add_light('CoreFireLight', 'POINT', (0.0, 0.0, 1.58), 320.0, (1.0, 0.44, 0.10), size=0.35)
    add_light('HearthGlowLight', 'POINT', (0.0, -0.35, 0.92), 140.0, (1.0, 0.38, 0.08), size=0.30)
    add_light('RimCool', 'AREA', (-3.4, -1.0, 2.8), 160.0, (0.48, 0.72, 1.0), size=2.6, rot=(math.radians(60), 0, math.radians(-108)))
    add_light('RimCopper', 'AREA', (3.4, 0.6, 2.5), 220.0, (1.0, 0.62, 0.28), size=2.6, rot=(math.radians(65), 0, math.radians(112)))
    add_light('KeyLight', 'AREA', (1.4, -4.0, 4.6), 190.0, (0.96, 0.95, 1.0), size=3.4, rot=(math.radians(38), 0, math.radians(16)))

    cam_data = bpy.data.cameras.new('HeroCamera')
    cam_data.lens = 50.0
    cam_obj = bpy.data.objects.new('HeroCamera', cam_data)
    cam_obj.location = cam_pos
    cam_obj.rotation_euler = (Vector((0.0, 0.0, 1.80)) - cam_pos).to_track_quat('-Z', 'Y').to_euler()
    link_obj(cam_obj, studio_col)

    scene = bpy.context.scene
    scene.camera = cam_obj
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'GPU'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = (dev.type == 'OPTIX')
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.transparent_max_bounces = 8
    scene.render.resolution_x = 800
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.compression = 15

    world = bpy.data.worlds.new('CrucibleWorld')
    scene.world = world
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs['Color'].default_value = (0.015, 0.014, 0.016, 1.0)
        bg.inputs['Strength'].default_value = 0.55

    scene.render.filepath = os.path.join(PUBLIC_ASSETS_DIR, 'crucible-fallback.png')
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    build_scene()
