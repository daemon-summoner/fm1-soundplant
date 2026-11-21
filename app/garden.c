/* SPDX-License-Identifier: MPL-2.0 */
/* The Garden page (HOME, third card): a plant for each track under a night sky. garden.h holds the state; this file reads
 * the engine into it once a frame (draw_garden) and draws it. Part of the unity build, after pages.c and before ui.c.
 *
 * The picture is drawn in bands (pic_next), so its body is pure: it reads the state and the palette made before the bands
 * and writes pixels. It uses its own span, disc and splat routines on the canvas (the 5-6-5 fields spread over a word, as
 * cv_fade does: one multiply a pixel). Places are laid out on a 240 x 120 picture; large type's shorter band scales them
 * (GY), never the shapes. */

#define GX_MASK 0x07E0F81Fu
#define GY(v16) ((v16) * MAIN_H / 120)               /* a y of the 240 x 120 picture (1/16 px) on the band */
#define GU(v) ((v) * h->sc >> 8)                     /* a length of a plant's head (1/16 px) at its row's size */

_Static_assert(GD_N == NTRK, "a plant for each instrument track");

enum { GS_FLOWER, GS_BELL, GS_REED, GS_FERN, GS_POM };
static const uint8_t GX_SPECIES[NENGINE] = {
    [EG_KNIT] = GS_FLOWER,   [EG_RAYON] = GS_BELL,    [EG_JACQUARD] = GS_FERN, [EG_BELLOWS] = GS_REED,
    [EG_CANE] = GS_REED,     [EG_VOILE] = GS_FERN,    [EG_SAMPLE] = GS_POM,    [EG_SLICE] = GS_POM,
    [EG_DRUMLINE] = GS_POM,  [EG_MIDI] = GS_BELL,     [EG_ACID] = GS_FLOWER};
static const uint8_t GX_FOG[3] = {9, 5, 0};          /* a row's share of the horizon's glow over its inks, of 16 */

static gd_t gdn;
static uint32_t gdn_t, gdn_deco;                     /* the page's last frame; the clock the last step saw */
static uint16_t gdn_pk[GD_N];                        /* the loudest the meters read since the last step */
static uint8_t gdn_rr;                               /* the track whose patterns are hashed next */

static void garden_knob(int k, int32_t e)
{
    if (k == 0)
        garden_glitch = (uint8_t)clampi((int)garden_glitch + (e > 0 ? 1 : -1), 0, GG_N - 1);
    else if (k == 1)
        garden_seed = (uint8_t)clampi((int)garden_seed + (int)e, 0, 99);
}

/* ------------------------------------------------------------------ canvas --- */
static inline uint32_t gx_sp(uint16_t c) { return ((uint32_t)c | (uint32_t)c << 16) & GX_MASK; }
static inline uint16_t gx_un(uint32_t q) { return (uint16_t)(q | q >> 16); }
static inline uint32_t gx_lerp(uint32_t p, uint32_t q, unsigned a)   /* p, a/32 of the way to q (spread) */
{
    return (p * (32u - a) + q * a) >> 5 & GX_MASK;
}
static inline void gx_blend(uint16_t *px, uint32_t cs, unsigned a)   /* a of 32 */
{
    *px = a >= 32u ? swap16(gx_un(cs)) : swap16(gx_un(gx_lerp(gx_sp(swap16(*px)), cs, a)));
}
static inline void gx_light(uint16_t *px, uint32_t cs, unsigned a)   /* adds a/32 of cs, to white at most */
{
    uint32_t o = gx_sp(swap16(*px)) + ((cs * a >> 5) & GX_MASK), c = o & 0x00010020u, d = o & 0x08000000u;
    o |= c - (c >> 5);                               /* a carry out of red or blue fills its field; out of green, its */
    o |= d - (d >> 6);
    *px = swap16(gx_un(o & GX_MASK));
}
static int gx_lo(void) { return cv_y0 - cv_oy < 0 ? 0 : (int)(cv_y0 - cv_oy); }          /* the picture rows this band holds */
static int gx_hi(void) { return cv_y1 - cv_oy > MAIN_H ? MAIN_H : (int)(cv_y1 - cv_oy); }
static uint16_t *gx_row(int y)                       /* picture row y on the canvas, 0 when another band has it */
{
    int32_t r = y + cv_oy;
    return r < cv_y0 || r >= cv_y1 ? 0 : &cv_px[(uint32_t)r * cv_w];
}
static void gx_fillrow(int y, uint16_t c)
{
    uint16_t *row = gx_row(y), s = swap16(c);
    if (row)
        for (int x = 0; x < 240; x++)
            row[x] = s;
}
/* [x0, x1) of picture row y, x in 1/16 px: the edge pixels as far covered as the span reaches them */
static void gx_span(int y, int x0, int x1, uint32_t cs, unsigned a, int light)
{
    uint16_t *row = gx_row(y);
    int i0 = x0 < 0 ? 0 : x0 >> 4, i1 = (x1 + 15) >> 4;
    if (!row || x1 <= x0 || !a)
        return;
    if (i1 > 240)
        i1 = 240;
    for (int i = i0; i < i1; i++) {
        int lo = i << 4 > x0 ? i << 4 : x0, hi = (i << 4) + 16 < x1 ? (i << 4) + 16 : x1;
        unsigned aa = (a * (unsigned)(hi - lo) + 8u) >> 4;
        if (aa)
            light ? gx_light(&row[i], cs, aa) : gx_blend(&row[i], cs, aa);
    }
}
/* a disc of radius r (1/16 px) at (cx, cy): its edge a pixel wide, a/32 of cs over what is there (light: added) */
static void gx_disc(int cx, int cy, int r, uint32_t cs, unsigned a, int light)
{
    int ro = r + 8, ri = r > 8 ? r - 8 : 0, ro2 = ro * ro, ri2 = ri * ri, inv = 2097152 / (ro2 - ri2), ya = gx_lo(),
        yb = gx_hi(), y0 = (cy - ro) >> 4, y1 = (cy + ro) >> 4, x0 = (cx - ro) >> 4, x1 = (cx + ro) >> 4;
    if (y0 < ya)
        y0 = ya;
    if (y1 >= yb)
        y1 = yb - 1;
    if (x0 < 0)
        x0 = 0;
    if (x1 > 239)
        x1 = 239;
    for (int y = y0; y <= y1; y++) {
        uint16_t *row = gx_row(y);
        int dy = y * 16 + 8 - cy, dy2 = dy * dy;
        if (!row || dy2 >= ro2)
            continue;
        for (int x = x0; x <= x1; x++) {
            int dx = x * 16 + 8 - cx, d2 = dx * dx + dy2, c;
            if (d2 >= ro2)
                continue;
            c = d2 <= ri2 ? 32 : (ro2 - d2) * inv >> 16;
            c = c * (int)a >> 5;
            if (c)
                light ? gx_light(&row[x], cs, (unsigned)c) : gx_blend(&row[x], cs, (unsigned)c);
        }
    }
}
/* light round (cx, cy): added, brightest at the middle (a of 32) and gone at r, smooth between */
static void gx_halo(int cx, int cy, int r, uint32_t cs, unsigned a)
{
    int r2 = r * r, inv = (1 << 24) / r2, ya = gx_lo(), yb = gx_hi(), y0 = (cy - r) >> 4, y1 = (cy + r) >> 4,
        x0 = (cx - r) >> 4, x1 = (cx + r) >> 4;
    if (y0 < ya)
        y0 = ya;
    if (y1 >= yb)
        y1 = yb - 1;
    if (x0 < 0)
        x0 = 0;
    if (x1 > 239)
        x1 = 239;
    for (int y = y0; y <= y1; y++) {
        uint16_t *row = gx_row(y);
        int dy = y * 16 + 8 - cy, dy2 = dy * dy;
        if (!row || dy2 >= r2)
            continue;
        for (int x = x0; x <= x1; x++) {
            int dx = x * 16 + 8 - cx, d2 = dx * dx + dy2, q;
            unsigned c;
            if (d2 >= r2)
                continue;
            q = (r2 - d2) * inv >> 16;
            c = (unsigned)(q * q >> 11) * a >> 5;
            if (c)
                gx_light(&row[x], cs, c);
        }
    }
}
/* a point at a sub-pixel place, spread over the four pixels it touches */
static void gx_splat(int x16, int y16, uint32_t cs, unsigned a, int light)
{
    int fx = x16 - 8, fy = y16 - 8, ix = fx >> 4, iy = fy >> 4, wx = fx & 15, wy = fy & 15;
    for (int j = 0; j < 2; j++) {
        uint16_t *row = gx_row(iy + j);
        int wj = j ? wy : 16 - wy;
        if (!row)
            continue;
        for (int i = 0; i < 2; i++) {
            int x = ix + i;
            unsigned aa = (a * (unsigned)((i ? wx : 16 - wx) * wj) + 128u) >> 8;
            if ((unsigned)x < 240u && aa)
                light ? gx_light(&row[x], cs, aa) : gx_blend(&row[x], cs, aa);
        }
    }
}

/* ----------------------------------------------------------------- palette --- */
/* the channels turned one place (red, green, blue become green, blue, red), s/16 of the way: the hue glitch and a gene */
static uint16_t gx_hue(uint16_t c, unsigned s)
{
    if (!s)
        return c;
    return col_mix(c, (uint16_t)((c >> 5 & 63u) >> 1 << 11 | (c & 31u) << 6 | c >> 11), s);
}
typedef struct {
    uint16_t sky0, sky1, hill, gnd, water, glow, moon;   /* RGB565, the glitch's hue turn in */
    uint32_t a1, a2, txt;                            /* spread: the aurora's two inks, the text colour */
    int16_t hz, wy, mx, my;                          /* the horizon and the water's top (rows); the moon (1/16 px) */
    uint8_t hue, tune;                               /* the glitch's turn, the gene's: of 16 */
    uint32_t deco;
} gp_t;
static void gx_palette(gp_t *p, unsigned hue, uint32_t deco)
{
    const theme_t *th = theme;
    uint16_t glow = col_mix(th->dim, th->ink[6], 6), bg = th->bg;
    uint32_t h = gd_hash(gdn.wseed, 0x30F1u);
    p->hue = (uint8_t)hue;
    p->tune = (uint8_t)((gdn.gene[3] >> 8) * 3u / 255u);
    p->sky0 = gx_hue(bg, hue);
    p->sky1 = gx_hue(col_mix(bg, glow, 8), hue);
    p->hill = gx_hue(col_mix(bg, glow, 3), hue);
    p->gnd = gx_hue(col_mix(bg, glow, 1), hue);
    p->water = gx_hue(col_mix(bg, glow, 4), hue);
    p->glow = gx_hue(glow, hue);
    p->moon = gx_hue(col_mix(th->text, th->ink[2], 2), hue);
    p->a1 = gx_sp(gx_hue(th->ink[3], hue));
    p->a2 = gx_sp(gx_hue(th->ink[5], hue));
    p->txt = gx_sp(gx_hue(th->text, hue));
    p->hz = (int16_t)(62 * MAIN_H / 120);
    p->wy = (int16_t)(108 * MAIN_H / 120);
    p->mx = (int16_t)((150 + h % 62u) * 16);
    p->my = (int16_t)(GY((12 + (h >> 8) % 14u) * 16));
    if (p->my < 11 * 16)
        p->my = 11 * 16;
    p->deco = deco;
}
static uint16_t gx_sky(const gp_t *p, int y)         /* the sky's colour on picture row y: dark above, the glow at the horizon */
{
    unsigned t = y >= p->hz ? 256u : (unsigned)y * 256u / (unsigned)p->hz;
    return gx_un(gx_lerp(gx_sp(p->sky0), gx_sp(p->sky1), t * t * 32u >> 16));
}

/* --------------------------------------------------------------- backdrop --- */
static void gx_back(const gp_t *p)                   /* the sky, the ground and the water, a colour a row */
{
    int y0 = gx_lo(), y1 = gx_hi();
    for (int y = y0; y < y1; y++) {
        uint16_t c;
        if (y < p->hz)
            c = gx_sky(p, y);
        else if (y < p->wy)
            c = gx_un(gx_lerp(gx_sp(p->hill), gx_sp(p->gnd), (unsigned)((y - p->hz) * 32 / (p->wy - p->hz))));
        else
            c = gx_un(gx_lerp(gx_sp(p->water), gx_sp(p->sky0), (unsigned)((y - p->wy) * 32 / (MAIN_H - p->wy))));
        gx_fillrow(y, c);
    }
}
static void gx_stars(const gp_t *p)
{
    int y0 = gx_lo(), y1 = gx_hi();
    for (int k = 0; k < 36; k++) {
        uint32_t h = gd_hash(gdn.wseed, 0x57A0u + (uint32_t)k);
        int x = (int)(h % 240u), y = 2 + (int)((h >> 8 & 255u) * (h >> 16 & 255u) >> 8) * (p->hz - 8) / 256;
        unsigned a = 14u + (h >> 24) % 20u, tw = (unsigned)(gd_sin((p->deco >> 6) * (1u + (unsigned)k % 3u) + (h >> 3)) + 190);
        uint32_t cs = k % 5 ? p->txt : gx_sp(gx_hue(col_mix(K_TEXT, theme->ink[k & 7], 6), p->hue));
        uint16_t *row;
        if (y < y0 || y >= y1)
            continue;
        a = a * tw / 256u * (unsigned)(p->hz - y) / (unsigned)p->hz;
        if (a > 32u)
            a = 32u;
        row = gx_row(y);
        gx_blend(&row[x], cs, a);
        if (k < 5 && a > 8u) {                       /* the brightest have rays */
            gx_blend(&row[x > 0 ? x - 1 : 0], cs, a / 4u);
            gx_blend(&row[x < 239 ? x + 1 : 239], cs, a / 4u);
            if ((row = gx_row(y - 1)) != 0)
                gx_blend(&row[x], cs, a / 4u);
            if ((row = gx_row(y + 1)) != 0)
                gx_blend(&row[x], cs, a / 4u);
        }
    }
}
static void gx_moon(const gp_t *p)
{
    uint32_t h = gd_hash(gdn.wseed, 0x30011u), cs = gx_sp(p->moon);
    int mx = p->mx, my = p->my, phase = (int)(h >> 4) % 3, side = h >> 8 & 1u ? 1 : -1;
    gx_disc(mx, my, 120, cs, 32, 0);
    gx_disc(mx - 40, my + 24, 28, gx_sp(col_mix(p->moon, p->sky1, 5)), 12, 0);   /* craters */
    gx_disc(mx + 36, my - 30, 20, gx_sp(col_mix(p->moon, p->sky1, 5)), 10, 0);
    if (phase)                                       /* a gibbous or a crescent: the sky's colour over a disc beside it */
        gx_disc(mx + side * (phase == 1 ? 5 : 8) * 16, my, 124, gx_sp(gx_sky(p, my >> 4)), 29, 0);
    gx_halo(mx, my, 26 * 16, cs, 6);
}
static void gx_aurora(const gp_t *p)
{
    int y0 = gx_lo(), y1 = gx_hi(), hgt = 9 + (int)gdn.aur * 12 / 255;
    unsigned amax = 4u + (unsigned)gdn.aur * 10u / 255u;
    for (int k = 0; k < 2; k++) {
        uint32_t cs = k ? p->a2 : p->a1, wh = gd_hash(gdn.wseed, 0xA0A0u + (uint32_t)k);
        unsigned ph = (wh & 255u) + (p->deco >> (5 + k));
        int base = (int)(GY((26 + 12 * k) * 16) >> 4);
        if (base + 8 < y0 || base - 8 - hgt >= y1)
            continue;
        for (int j = 0; j < 80; j++) {
            int x = j * 3, yc = base + (gd_sin((unsigned)j * 6u + ph) * 5 + gd_sin((unsigned)j * 15u - ph * 2u + (wh >> 8)) * 2) / 127;
            unsigned ray = (unsigned)(170 + gd_sin((unsigned)j * 9u + ph + (unsigned)k * 90u));
            for (int r = -2; r < hgt; r++) {         /* from the bright lower edge up, fading; a soft foot under it */
                int y = yc - r;
                unsigned u = r < 0 ? 256u : (unsigned)(hgt - r) * 256u / (unsigned)hgt,
                         a = ((u * u >> 8) * ray >> 8) * amax * (r < 0 ? (unsigned)(3 + r) * 85u : 256u) >> 16;
                uint16_t *row;
                if (y < y0 || y >= y1 || !a || !(row = gx_row(y)))
                    continue;
                gx_light(&row[x], cs, a);
                gx_light(&row[x + 1], cs, a);
                gx_light(&row[x + 2], cs, a);
            }
        }
    }
}
static void gx_hills(const gp_t *p)                  /* the far ridge: a silhouette on the horizon's glow */
{
    uint32_t h = gd_hash(gdn.wseed, 0x4111u), cs = gx_sp(p->hill);
    unsigned pa = h & 255u, pb = h >> 8 & 255u;
    int y0 = gx_lo(), y1 = gx_hi();
    uint16_t sh = swap16(p->hill);
    for (int x = 0; x < 240; x++) {
        int ridge = 8 * 16 + gd_sin((unsigned)x * 7u / 3u + pa) * 64 / 127 + gd_sin((unsigned)x * 11u / 2u + pb) * 40 / 127 +
                    gd_sin((unsigned)x * 11u) * 16 / 127,
            top = p->hz * 16 - GY(ridge), yi = top >> 4;
        if (yi >= y1 || p->hz <= y0)
            continue;
        if (yi >= y0) {
            uint16_t *row = gx_row(yi);
            gx_blend(&row[x], cs, (unsigned)(16 - (top & 15)) * 2u);
            yi++;
        }
        for (int y = yi < y0 ? y0 : yi; y < p->hz && y < y1; y++)
            gx_row(y)[x] = sh;
    }
}
static void gx_ground(const gp_t *p)                 /* specks of light and tufts of grass on the ground */
{
    int y0 = gx_lo(), y1 = gx_hi();
    uint32_t cs = gx_sp(p->glow), cg = gx_sp(col_mix(p->sky0, gx_un(p->a1), 6));
    for (int k = 0; k < 40; k++) {
        uint32_t h = gd_hash(gdn.wseed, 0x6A00u + (uint32_t)k);
        int y = p->hz + 3 + (int)(h >> 8) % (p->wy - p->hz - 4);
        if (y >= y0 && y < y1)
            gx_blend(&gx_row(y)[h % 240u], cs, 5u + (h >> 16) % 7u);
    }
    for (int k = 0; k < 22; k++) {                   /* each tuft: four blades, fanned, the far ones paler */
        uint32_t h = gd_hash(gdn.wseed, 0x6B00u + (uint32_t)k);
        int bx = 4 + (int)(h % 232u), by = p->hz + 8 + (int)(h >> 9) % (p->wy - p->hz - 10), len = 3 + (int)(h >> 20 & 3u) + (by - p->hz) / 10;
        if (by - len >= y1 || by < y0)
            continue;
        for (int b = 0; b < 4; b++) {
            int dx = (b - 2) * 2 + (b > 1), lean = (b - 1) - (int)(h >> (24 + b) & 1u), bl = len - (b & 1u) - (b == 0 || b == 3);
            for (int j = 0; j < bl; j++) {
                int y = by - j, x = bx + dx + (lean * j) / 3;
                if (y >= y0 && y < y1 && x >= 0 && x < 240)
                    gx_blend(&gx_row(y)[x], cg, 17u - (unsigned)j * 2u);
            }
        }
    }
}
static void gx_water(const gp_t *p)                  /* a bank, glitter on the moon's side, and a shimmer of the aurora */
{
    int ya = p->wy > gx_lo() ? p->wy : gx_lo(), yb = gx_hi();
    uint32_t cm = gx_sp(p->moon), cg = gx_sp(p->glow);
    if (ya >= yb)
        return;
    if (p->wy >= gx_lo() && p->wy < yb)
        gx_span(p->wy, 0, 240 * 16, cg, 8, 0);
    for (int y = ya; y < yb; y++) {
        uint32_t h = gd_hash(gdn.wseed + (uint32_t)y, p->deco >> 8);
        int d = y - p->wy, mw = (10 - d / 2) * 16, cx = p->mx + ((int)(h & 15u) - 8) * 16;
        gx_span(y, cx - mw, cx + mw, cm, 7u + (h >> 4 & 7u), 0);
        gx_span(y, (int)(h >> 8) % 224 * 16, ((int)(h >> 8) % 224 + 4 + (int)(h >> 20 & 7u)) * 16, cg, 8, 0);
        gx_span(y, (int)(h >> 12) % 224 * 16, ((int)(h >> 12) % 224 + 3 + (int)(h >> 24 & 7u)) * 16, p->a1, 2u + (unsigned)gdn.aur / 40u, 1);
    }
}

/* ------------------------------------------------------------------ plants --- */
typedef struct { int bx, by, dx, h, c; } gx_stem_t;  /* 1/16 px: x = bx + dx t^2, y = by - h (t - c t^2), c of 256 */
typedef struct { int x, y, sc, lean; unsigned open, act, g0, g1; uint32_t col, col2, core; } gx_hd_t;

static int gx_stem_t1024(const gx_stem_t *s, int u)   /* the t, of 1024, at which the stem has climbed u of 1024 of h */
{
    int t = u;
    for (int i = 0; i < 2; i++) {                    /* Newton on t - c t^2 = u */
        int f = t - (s->c * t >> 8) * t / 1024 - u, d = 1024 - (s->c * t >> 7);
        t -= f * 1024 / d;
    }
    return t < 0 ? 0 : t > 1024 ? 1024 : t;
}
static int gx_stem_x(const gx_stem_t *s, int t) { return s->bx + (s->dx * t >> 10) * t / 1024; }
static int gx_stem_y(const gx_stem_t *s, int t) { return s->by - s->h * (t - (s->c * t >> 8) * t / 1024) / 1024; }

static void gx_stem(const gx_stem_t *s, int wb, int wt, uint32_t cs)
{
    int ytop = s->by - s->h * (256 - s->c) / 256, y0 = ytop >> 4, y1 = s->by >> 4, ya = gx_lo(), yb = gx_hi();
    if (s->h <= 0)
        return;
    if (y0 < ya)
        y0 = ya;
    if (y1 >= yb)
        y1 = yb - 1;
    for (int y = y1; y >= y0; y--) {
        int yt = y * 16 < ytop ? ytop : y * 16, yd = y * 16 + 16 > s->by ? s->by : y * 16 + 16, ut, ud, xt, xd, w;
        if (yd <= yt)
            continue;
        ut = (s->by - yt) * 1024 / s->h;
        ud = (s->by - yd) * 1024 / s->h;
        xt = gx_stem_x(s, gx_stem_t1024(s, ut));
        xd = gx_stem_x(s, gx_stem_t1024(s, ud));
        w = (wb + (wt - wb) * ((ut + ud) >> 1) / 1024) >> 1;
        gx_span(y, (xt < xd ? xt : xd) - w, (xt < xd ? xd : xt) + w, cs, 32, 0);
    }
}
/* a leaf: four discs along a curve from the stem at t out to the side and up (lx, ly in 1/16 px; sag: a wilted leaf's) */
static void gx_leaf(const gx_stem_t *s, int t, int side, int lx, int ly, int r, uint32_t cs, int sag)
{
    static const uint8_t W[4] = {9, 12, 10, 6};      /* the leaf's width along it, of 12 */
    int px = gx_stem_x(s, t), py = gx_stem_y(s, t), cx = px + side * lx * 9 / 10, cy = py - ly / 5, tx = px + side * lx,
        ty = py - ly + sag;
    for (int j = 1; j <= 4; j++) {
        int u = j * 64, v = 256 - u;
        gx_disc((v * v * px + 2 * u * v * cx + u * u * tx) >> 16, (v * v * py + 2 * u * v * cy + u * u * ty) >> 16, r * W[j - 1] / 12, cs,
                32, 0);
    }
}

static void gx_flower(const gx_hd_t *h)
{
    int pc = 5 + (int)(h->g0 * 4u >> 8), k = 256 + (int)(h->act >> 1), rot = (int)(h->g1 >> 2) + h->lean / 24,
        dist = GU(19 + (int)(h->open * 58u >> 8)) * k >> 8, rad = GU(32 + (int)(h->open * 30u >> 8)) * k >> 8;
    for (int i = 0; i < pc; i++) {
        unsigned a = (unsigned)(i * 256 / pc + rot);
        gx_disc(h->x + dist * gd_cos(a) / 127, h->y + dist * gd_sin(a) * 7 / 1016, rad, i & 1 ? h->col2 : h->col, 32, 0);
    }
    gx_disc(h->x, h->y, GU(34), h->core, 32, 0);
}
static void gx_bell(const gx_hd_t *h)                /* a cup hanging from the stem's end, its lip flaring with the cutoff */
{
    int hgt = GU(160), top = h->y - hgt / 3, lip = GU(72 + (int)(h->open * 48u >> 8)), w0 = GU(26);
    for (int y = top >> 4; y <= (top + hgt) >> 4; y++) {
        int f = (y * 16 + 8 - top) * 256 / hgt, w, sh;
        if (f < 0 || f > 256)
            continue;
        w = w0 + (lip - w0) * (f * f >> 8) / 256;
        sh = h->lean * f >> 11;
        gx_span(y, h->x + sh - w, h->x + sh + w, f > 232 ? h->col2 : h->col, 32, 0);
    }
    gx_disc(h->x + (h->lean >> 6) + 8, top + hgt + GU(24), GU(24), h->core, 32, 0);
}
static void gx_reed(const gx_hd_t *h)                /* a cattail: a thick head and a spike */
{
    int r = GU(28 + (int)(h->open * 8u >> 8)), st = GU(40);
    for (int j = 0; j < 4; j++)
        gx_disc(h->x + (h->lean * j >> 10), h->y - j * st, r, j == 3 ? h->col2 : h->col, 32, 0);
    for (int k = 0; k < 5; k++)
        gx_span(((h->y - 3 * st - r) >> 4) - k, h->x - 8, h->x + 8, h->col2, 32u - (unsigned)k * 5u, 0);
}
static void gx_fern(const gx_hd_t *h)                /* three fronds, curled tight and unrolling with the cutoff */
{
    int o = (int)h->open;
    for (int f = 0; f < 3; f++) {
        int dir = f - 1, ang = 192 + dir * 40, step = GU(18 + (int)(h->open * 8u >> 8)),
            mag = (12 + (int)(h->g1 >> 4)) * (300 - o) / 300, curl = dir ? -dir * mag : (h->g1 & 1u ? mag : -mag) / 2, x = h->x,
            y = h->y;
        for (int k = 0; k < 6; k++) {
            gx_disc(x, y, GU(30 - 2 * k), k & 1 ? h->col2 : h->col, 32, 0);
            x += step * gd_cos((unsigned)ang) / 127;
            y += step * gd_sin((unsigned)ang) / 127;
            ang += curl;
        }
    }
}
static void gx_pom(const gx_hd_t *h)                 /* a sunflower head: dots at the golden angle */
{
    static const uint8_t SQ[13] = {0, 16, 23, 28, 32, 36, 39, 42, 45, 48, 51, 53, 55};
    int k = 256 + (int)(h->act >> 2), sp = (170 + (int)(h->open >> 1)) * k >> 8;
    for (int i = 12; i >= 0; i--) {
        unsigned a = (unsigned)(i * 98 + (int)h->g1);
        int d = GU(SQ[i] * sp >> 8);
        gx_disc(h->x + d * gd_cos(a) / 127, h->y + d * gd_sin(a) / 127, GU(26), i ? (i % 3 ? h->col : h->col2) : h->core, 32, 0);
    }
}

#define SU(v) ((v) * sc >> 8)                        /* a length of a plant (1/16 px at the nearest row's size) at its row's */
static void gx_plant(const gp_t *p, int i)
{
    const gd_plant_t *pl = &gdn.pl[i];
    gd_geo_t o;
    gx_stem_t s;
    gx_hd_t hd;
    uint16_t ic = gx_hue(trk_ink(i), p->tune), stem, head;
    int row, sc, bx, by, hx, hy, species, wb, wt, sag, ya = gx_lo(), yb = gx_hi();
    unsigned act = gd_act(&gdn, i);
    uint32_t cs;
    gd_geom(&gdn, i, &o);
    row = o.row;
    sc = GD_SC[row];
    bx = o.bx, hx = o.hx, by = GY(o.by), hy = GY(o.hy);
    if ((hy >> 4) - 26 >= yb || (by >> 4) + 8 < ya)
        return;
    ic = col_mix(ic, p->glow, GX_FOG[row]);
    ic = col_mix(ic, K_FAINT, pl->wilt * 10u / 255u);
    ic = col_mix(ic, K_FAINT, (255u - pl->grow) * 5u / 255u);
    ic = gx_hue(col_mix(ic, K_TEXT, pl->lift * 4u / 255u), p->hue);
    stem = col_mix(ic, K_BG, 6);
    head = col_mix(ic, K_TEXT, act * 5u / 255u);
    cs = gx_sp(stem);
    species = GX_SPECIES[proj.trk[i].par[TP_ENGINE] % NENGINE];

    {                                                /* the shadow and, after a hit, a ring running out over the ground */
        static const uint8_t W[4] = {40, 56, 44, 24};
        for (int j = 0; j < 4; j++) {
            int w = W[j] * sc >> 8;
            gx_span((by >> 4) - 1 + j, bx - w, bx + w, 0, 14, 0);
        }
        if (pl->ripple) {
            int rx = (64 + (255 - pl->ripple) * 420 / 255) * sc >> 8, n = 16 + rx / 20;
            uint32_t cr = gx_sp(head);
            for (int k = 0; k < n; k++) {
                unsigned a = (unsigned)(k * 256 / n);
                gx_splat(bx + rx * gd_cos(a) / 127, by + 24 + rx * gd_sin(a) / 508, cr, pl->ripple * 12u / 255u, 0);
            }
        }
    }

    s.bx = bx, s.by = by, s.dx = o.dx, s.c = o.c;
    s.h = (by - hy) * 256 / (256 - o.c);
    wb = SU(50);
    wt = SU(32);
    sag = (int)(pl->wilt * 6u / 255u) * 16;
    if (species == GS_REED) {                        /* long blades */
        gx_leaf(&s, 150, -1, SU(64), SU(208), SU(22), cs, sag);
        gx_leaf(&s, 330, 1, SU(64), SU(240), SU(22), cs, sag);
    } else if (species != GS_FERN) {
        gx_leaf(&s, 260, -1, SU(128), SU(80), SU(28), cs, sag);
        gx_leaf(&s, 520, 1, SU(128), SU(80), SU(28), cs, sag);
    }
    gx_stem(&s, wb, wt, cs);

    hd.x = hx, hd.y = hy;
    hd.sc = sc * (184 + (int)(pl->grow * 206u / 255u)) >> 8;
    hd.lean = o.dx;
    hd.open = pl->open * (256u - pl->wilt * 96u / 255u) >> 8;
    hd.act = act;
    hd.g0 = gdn.gene[0] >> 8;
    hd.g1 = gdn.gene[1] >> 8;
    hd.col = gx_sp(head);
    hd.col2 = gx_sp(col_mix(head, K_TEXT, 4));
    hd.core = gx_sp(col_mix(head, K_TEXT, 8));
    switch (species) {
    case GS_BELL: gx_bell(&hd); break;
    case GS_REED: gx_reed(&hd); break;
    case GS_FERN: gx_fern(&hd); break;
    case GS_POM: gx_pom(&hd); break;
    default: gx_flower(&hd); break;
    }
    if (act > 14u)
        gx_halo(hx, hy, (11 + (int)(act * 9u / 255u)) * hd.sc >> 4, gx_sp(head), act * 11u / 255u);
}
static void gx_parts(const gp_t *p)                  /* petals and pollen, from the plant that threw them */
{
    for (int i = 0; i < GD_NP; i++) {
        unsigned life = gdn.plo[i] >> 3;
        int own = gdn.plo[i] & 7;
        uint16_t c;
        if (!life)
            continue;
        c = col_mix(gx_hue(col_mix(trk_ink(own), p->glow, GX_FOG[GD_ROW[own]]), p->hue), K_TEXT, 5);
        gx_disc(gdn.pt[i].x, GY(gdn.pt[i].y), 22, gx_sp(c), life > 8u ? 32u : life * 4u, 0);
    }
}
static void gx_flies(const gp_t *p)
{
    uint32_t cs = gx_sp(gx_hue(col_mix(K_TEXT, theme->ink[2], 8), p->hue));
    for (int j = 0; j < GD_NF; j++) {
        unsigned a = (unsigned)(22 + gd_sin((p->deco >> 3) + (unsigned)j * 47u) / 10);
        gx_halo(gdn.fl[j].x, GY(gdn.fl[j].y), 80, cs, 14);
        gx_splat(gdn.fl[j].x, GY(gdn.fl[j].y), cs, a, 0);
    }
}

/* ----------------------------------------------------------------- glitches --- */
/* one row's pixels shifted by dx, the red and the blue pulled apart by ch (the swapped 5-6-5 words: red 0x00F8, green
 * 0xE007, blue 0x1F00) */
static void gx_shift(uint16_t *row, int dx, int ch)
{
    uint16_t t[240];
    memcpy(t, row, sizeof t);
    for (int x = 0; x < 240; x++) {
        int r = clampi(x - dx - ch, 0, 239), g = clampi(x - dx, 0, 239), b = clampi(x - dx + ch, 0, 239);
        row[x] = (uint16_t)((t[r] & 0x00F8u) | (t[g] & 0xE007u) | (t[b] & 0x1F00u));
    }
}
static void gx_glitch(int kind, unsigned amt, uint32_t ks)
{
    int y0 = gx_lo(), y1 = gx_hi();
    if (kind == GK_TEAR) {                           /* three strips of rows torn sideways, the colours split */
        for (int k = 0; k < 3; k++) {
            uint32_t h = gd_hash(ks, (uint32_t)k);
            int ys = (int)(h % (uint32_t)(MAIN_H - 6)), n = 3 + (int)(h >> 8) % 4, dx = (int)(amt * (3u + (h >> 16) % 12u) / 255u),
                ch = (int)(amt * 3u / 255u);
            for (int y = ys < y0 ? y0 : ys; y < ys + n && y < y1; y++)
                gx_shift(gx_row(y), h >> 12 & 1u ? dx : -dx, ch);
        }
    } else if (kind == GK_FOLD) {                    /* the middle mirrored, widening to the whole left half */
        int w = (int)(120u * amt / 255u);
        for (int y = y0; y < y1; y++) {
            uint16_t *row = gx_row(y);
            for (int x = 120 - w; x < 120; x++)
                row[x] = row[239 - x];
        }
    } else if (kind == GK_DERES) {                   /* blocks up to six pixels: sixty rows split into whole blocks */
        int bs = 1 + (int)(amt * 5u / 255u);
        if (bs > 1)
            for (int r = cv_y0; r < cv_y1; r += bs) {
                uint16_t *row = &cv_px[(uint32_t)r * cv_w];
                for (int x = 0; x < 240; x += bs)
                    for (int k = 1; k < bs && x + k < 240; k++)
                        row[x + k] = row[x];
                for (int k = 1; k < bs && r + k < cv_y1; k++)
                    memcpy(&cv_px[(uint32_t)(r + k) * cv_w], row, 240 * sizeof row[0]);
            }
    }
}

/* ---------------------------------------------------------------- the page --- */
static void garden_feed(int t)                       /* one track's patterns into the seed */
{
    const tpat_t *tp = tpat(t);
    int alive = 0;
    for (int s = 0; s < NSTEP && !alive; s++)
        alive = cell_on(tp, t, s);
    gd_seed_feed(&gdn, t, hash_pat(2166136261u, tp), alive, garden_seed);
}
static void garden_gather(gd_in_t *in, uint32_t now, uint32_t deco)
{
    unsigned top = 0;
    memset(in, 0, sizeof *in);
    for (int t = 0; t < GD_N; t++) {
        int cut = engine_live(t, TP_CUT), pan = engine_live(t, TP_PAN),
            lv = gdn_pk[t] ? (int)((lin_db((float)gdn_pk[t] * (1.0f / 16383.5f)) + 45.0f) * (255.0f / 36.0f)) : 0;
        lv = clampi(lv, 0, 255);
        in->hit[t] = eng_hit[t];
        in->vel[t] = eng_hit_vel[t];
        in->lvl[t] = (uint8_t)lv;
        in->cut[t] = (uint8_t)(cut >= 0 ? cut : proj.trk[t].par[TP_CUT]);
        in->pan[t] = (int8_t)((pan >= 0 ? pan : proj.trk[t].par[TP_PAN]) - 64);
        top = (unsigned)lv > top ? (unsigned)lv : top;
    }
    in->mute = (uint8_t)seq.mute;
    in->solo = (uint8_t)ui.solo;
    in->playing = seq.playing != 0;
    in->still = an.still;
    in->live = deco != gdn_deco;
    in->level = garden_glitch;
    in->master = (uint8_t)top;
    in->now = now;
    in->step = seq.step_tick;
}
static void draw_garden(void)
{
    uint32_t now = an.now, deco = an.deco, h = 2166136261u;
    int fresh = !gdn.started || now - gdn_t > MV_GAP_MS;
    gp_t pal;
    gdn_t = now;
    if (fresh) {                                     /* the page opens (or comes back after a gap): the whole seed, and the plants grow in */
        memset(&gdn, 0, sizeof gdn);
        memset(gdn_pk, 0, sizeof gdn_pk);
        for (int t = 0; t < GD_N; t++)
            garden_feed(t);
        gdn_rr = 0;
    } else {
        garden_feed(gdn_rr);
        gdn_rr = (uint8_t)((gdn_rr + 1u) % GD_N);
    }
    for (int t = 0; t < GD_N; t++)
        gdn_pk[t] = ui_peak[t] > gdn_pk[t] ? ui_peak[t] : gdn_pk[t];
    if (fresh || now - gdn.last >= GD_TICK_MS) {
        gd_in_t in;
        garden_gather(&in, now, deco);
        gd_step(&gdn, &in);
        gdn_deco = deco;
        memset(gdn_pk, 0, sizeof gdn_pk);
    }
    h = hash_u(h, (uint32_t)an.still | (uint32_t)LARGE << 1);
    for (int t = 0; t < GD_N; t++)
        h = hash_u(h, GX_SPECIES[proj.trk[t].par[TP_ENGINE] % NENGINE]);
    h = gd_sig(&gdn, h, deco);
    if (!begin_main(h))
        return;
    gx_palette(&pal, gdn.g_kind == GK_HUE ? gdn.g_amt * 9u / 255u : 0u, deco);
    MAIN_BANDS {
        gx_back(&pal);
        gx_stars(&pal);
        gx_moon(&pal);
        gx_aurora(&pal);
        gx_hills(&pal);
        gx_ground(&pal);
        gx_water(&pal);
        for (int row = 0; row < 3; row++)
            for (int i = 0; i < GD_N; i++)
                if (GD_ROW[i] == row)
                    gx_plant(&pal, i);
        gx_parts(&pal);
        gx_flies(&pal);
        if (gdn.g_kind)
            gx_glitch(gdn.g_kind, gdn.g_amt, gd_hash(gdn.wseed, gdn.g_t0 + (deco >> 7)));
    }
}
