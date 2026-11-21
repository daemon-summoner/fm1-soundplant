/* SPDX-License-Identifier: MPL-2.0 */
/* The garden's state, with no screen in it: the plants' springs and moods, the petals, the fireflies, the genes, the glitch
 * schedule and its flash guard. garden.c draws it (the Garden page); tests/host/garden_test.c pins it. Integers only, in a
 * virtual picture 240 x 120 (positions in 1/16 pixel), stepped from a clock the caller gives it (so a test drives it
 * without a screen or a wall clock). */
#pragma once
#include <stdint.h>

#define GD_N 8                                       /* plants: one a track */
#define GD_NP 16                                     /* petals and pollen in the air at most */
#define GD_NF 6                                      /* fireflies */
#define GD_TICK_MS 33u                               /* the state moves this often at most */
#define GD_FLASH_MAX 3u                              /* glitches begun in any GD_FLASH_MS (WCAG 2.3.1: three flashes a second) */
#define GD_FLASH_MS 1000u
#define GD_MUTATE_STEPS 64u                          /* a gene mutates every four bars */
#define GD_W 240
#define GD_VH 120

enum { GK_NONE, GK_TEAR, GK_FOLD, GK_HUE, GK_DERES, GK_N };
enum { GG_OFF, GG_SOFT, GG_LIVELY, GG_WILD, GG_N };

typedef struct { int16_t x, y; int8_t vx, vy; } gd_part_t;
typedef struct { int16_t x, y; int8_t vx, vy; } gd_fly_t;
typedef struct {
    int16_t bend, spin;                              /* the stem's sway at its head (1/256 px) and its speed */
    uint8_t seen, pulse, open, halo, wilt, lift, grow, ripple;
    int8_t pan;
} gd_plant_t;
typedef struct {
    gd_plant_t pl[GD_N];
    gd_part_t pt[GD_NP];
    uint8_t plo[GD_NP];                              /* each petal's life (5 bits, 31 = new) << 3 | its plant; 0: not in the air */
    gd_fly_t fl[GD_NF];
    uint16_t gene[4];                                /* petals, curl, height, hue: 8.8, easing to gene_to */
    uint32_t seed, wseed, acc, last;                 /* seed: the patterns' hash (the genes); wseed: the sky's and the glitches'
                                                      * (held while the page is open: an edit moves a gene, not the sky) */
    uint32_t step;                                   /* the sixteenth last looked at */
    uint16_t flash[3], g_t0, g_dur, epoch;
    uint8_t gene_to[4], ne[4];
    uint8_t nflash, fi, g_kind, g_amt, aur, alive, user, sub, head, started;
} gd_t;

/* what the caller reads off the engine and the project, once a frame */
typedef struct {
    uint8_t hit[GD_N], vel[GD_N], lvl[GD_N], cut[GD_N];   /* eng_hit, eng_hit_vel, the meter (0..255), the cutoff (0..127) */
    int8_t pan[GD_N];                                /* -64 .. 63 */
    uint8_t mute, solo;                              /* bit per track */
    uint8_t playing, still, live, level, master;     /* live: the page's clock ran (something sounds); level: the glitch knob
                                                      * (GG_*); master: 0..255 */
    uint32_t now, step;                              /* ms; sixteenths since the start */
} gd_in_t;

static const uint8_t GD_QS[65] = {0,   3,   6,   9,   12,  16,  19,  22,  25,  28,  31,  34,  37,  40,  43,  46,  49,
                                  51,  54,  57,  60,  63,  65,  68,  71,  73,  76,  78,  81,  83,  85,  88,  90,  92,
                                  94,  96,  98,  100, 102, 104, 106, 107, 109, 111, 112, 113, 115, 116, 117, 118, 120,
                                  121, 122, 122, 123, 124, 125, 125, 126, 126, 126, 127, 127, 127, 127};
static inline int gd_sin(unsigned a)                 /* a: 256 to the turn; -127 .. 127 */
{
    unsigned q = a & 63u, h = a >> 6 & 3u;
    int v = GD_QS[h & 1u ? 64u - q : q];
    return h & 2u ? -v : v;
}
static inline int gd_cos(unsigned a) { return gd_sin(a + 64u); }

static inline uint32_t gd_hash(uint32_t a, uint32_t b)
{
    uint32_t h = a * 0x9E3779B1u + b * 0x85EBCA77u + 0x165667B1u;
    h ^= h >> 15;
    h *= 0x2C1B3C6Du;
    h ^= h >> 12;
    h *= 0x297A2D39u;
    h ^= h >> 15;
    return h;
}

/* the hits since the last look: a counter that wrapped counts the same (256 hits between two looks read as none: the
 * counter is a byte) */
static inline unsigned gd_hits(uint8_t count, uint8_t *seen)
{
    unsigned n = (uint8_t)(count - *seen);
    *seen = count;
    return n;
}

/* The glitch a beat starts: GK_NONE for most. `lvl` is the knob (GG_*): the share of beats, in percent */
static inline int gd_pick(uint32_t wseed, uint32_t beat, int lvl)
{
    static const uint8_t PCT[GG_N] = {0, 12, 26, 45};
    uint32_t h;
    if (lvl <= 0 || lvl >= GG_N)
        return GK_NONE;
    h = gd_hash(wseed, beat);
    if (h % 100u >= PCT[lvl])
        return GK_NONE;
    return 1 + (int)((h >> 8) % (GK_N - 1u));
}
static inline unsigned gd_glitch_ms(uint32_t wseed, uint32_t beat) { return 360u + (gd_hash(wseed, beat) >> 20) % 360u; }

/* The flash guard: a glitch may begin only when fewer than GD_FLASH_MAX began in the last GD_FLASH_MS */
static inline int gd_flash_ok(const gd_t *g, uint32_t now)
{
    return g->nflash < GD_FLASH_MAX || (uint16_t)((uint16_t)now - g->flash[g->fi]) >= GD_FLASH_MS;
}
static inline void gd_flash_note(gd_t *g, uint32_t now)
{
    g->flash[g->fi] = (uint16_t)now;
    g->fi = (uint8_t)((g->fi + 1u) % GD_FLASH_MAX);
    if (g->nflash < GD_FLASH_MAX)
        g->nflash++;
}

/* a glitch's strength 0..255 at age of dur: smooth up over the first third, held, smooth down over the last third */
static inline unsigned gd_env(unsigned age, unsigned dur)
{
    unsigned p = age >= dur ? 255u : age * 255u / dur, t = p < 85u ? p * 3u : p > 170u ? (255u - p) * 3u : 255u;
    return t * t * (765u - 2u * t) / 65025u;
}

/* what is on the plant: the larger of its pulse and its halo (0..255) */
static inline unsigned gd_act(const gd_t *g, int i)
{
    return g->pl[i].pulse > g->pl[i].halo ? g->pl[i].pulse : g->pl[i].halo;
}

/* ------------------------------------------------------------------ geometry --- */
static const uint8_t GD_ROW[GD_N] = {2, 0, 1, 2, 0, 1, 2, 0};   /* each plant's row: 0 far, 1 middle, 2 near */
static const uint8_t GD_BY[3] = {70, 84, 100};                  /* the rows' ground */
static const uint8_t GD_HMAX[3] = {26, 35, 46};                 /* and their tallest stem */
static const uint16_t GD_SC[3] = {154, 205, 256};               /* and their size (of 256) */
typedef struct { int16_t bx, by, hx, hy, dx, c; uint8_t row, h; } gd_geo_t;
/* where plant i stands and where its head is (1/16 px): the stem runs x = bx + dx t^2, y = by - h (t - c t^2) for t in 0..1 */
static inline void gd_geom(const gd_t *g, int i, gd_geo_t *o)
{
    const gd_plant_t *p = &g->pl[i];
    uint32_t ph = gd_hash(g->wseed, (uint32_t)i);
    int row = GD_ROW[i], sc = GD_SC[row], jit = (int)((ph >> 4) % 13u) - 6, side = ph >> 20 & 1u ? 1 : -1;
    int hf = 200 + (int)(ph >> 8 & 63u) + (g->gene[2] >> 8) * 40 / 255, gf = 77 + p->grow * 179 / 255,
        lf = 256 + p->lift * 56 / 255, wf = 256 - p->wilt * 30 / 255;
    int h = GD_HMAX[row] * hf >> 8, dx;
    h = h * gf >> 8;
    h = h * lf >> 8;
    h = h * wf >> 8;
    o->row = (uint8_t)row;
    o->h = (uint8_t)h;
    o->bx = (int16_t)((16 + 30 * i + jit) * 16 + p->pan * 5 / 4);
    o->by = (int16_t)(GD_BY[row] * 16);
    dx = (p->pan * 3 / 2 + ((int)(g->gene[1] >> 8) - 128) * 3 / 4 * side) * sc >> 8;
    dx += p->bend / 16 * sc >> 8;
    o->c = (int16_t)(p->wilt * 100 / 255);
    dx += side * (h * 16 * p->wilt / 255) * 90 / 256;
    o->dx = (int16_t)dx;
    o->hx = (int16_t)(o->bx + dx);
    o->hy = (int16_t)(o->by - h * 16 * (256 - o->c) / 256);
}

/* ---------------------------------------------------------------------- state --- */
static inline void gd_genes_to(gd_t *g, int only)
{
    for (int k = 0; k < 4; k++)
        if (only < 0 || only == k)
            g->gene_to[k] = (uint8_t)(gd_hash(g->seed, (uint32_t)k + 4u * g->ne[k]) >> 24);
}
/* the patterns' hash of one track, round the tracks; after the last the seed is known (the sky's only when the page opens or
 * the user's seed moves) */
static inline void gd_seed_feed(gd_t *g, int t, uint32_t h, int alive, uint8_t user)
{
    g->acc = gd_hash(g->acc, h + (uint32_t)t);
    g->alive = (uint8_t)(alive ? g->alive | 1u << t : g->alive & ~(1u << t));
    if (t == GD_N - 1) {
        uint32_t base = g->acc, s = gd_hash(base, user);
        g->acc = 0;
        if (!g->started || s != g->seed) {
            g->seed = s;
            gd_genes_to(g, -1);
            if (!g->started)
                for (int k = 0; k < 4; k++)
                    g->gene[k] = (uint16_t)(g->gene_to[k] << 8);
        }
        if (!g->started || user != g->user)
            g->wseed = gd_hash(base, 0x5EED00u + user), g->user = user;
    }
}

static inline int gd_ease8(int cur, int to, unsigned dt, unsigned tau)
{
    int d = to - cur, k = dt >= tau ? 256 : (int)(dt * 256u / tau), s = d * k / 256;
    if (d && !s)
        s = d > 0 ? 1 : -1;
    return cur + s;
}

static inline void gd_burst(gd_t *g, int own, int vel)
{
    gd_geo_t o;
    uint32_t h = gd_hash(g->wseed ^ (uint32_t)own << 8, g->pl[own].seen + 64u * (uint32_t)g->head);
    int n = 2 + (vel - 100) / 9;
    gd_geom(g, own, &o);
    for (int j = 0; j < n; j++) {
        gd_part_t *q = &g->pt[g->head];
        uint8_t *lo = &g->plo[g->head];
        unsigned a = (h >> (4 * j & 15)) & 255u, sp = 5u + (unsigned)vel / 14u + (h >> (j + 8) & 3u);
        g->head = (uint8_t)((g->head + 1u) % GD_NP);       /* the oldest is taken over: the pool never grows */
        q->x = o.hx, q->y = o.hy;
        q->vx = (int8_t)(gd_cos(a) * (int)sp / 127);
        q->vy = (int8_t)(gd_sin(a) * (int)sp / 127 - 5);
        *lo = (uint8_t)(31u << 3 | (unsigned)own);
    }
}

static inline int gd_particles(const gd_t *g)
{
    int n = 0;
    for (int i = 0; i < GD_NP; i++)
        n += g->plo[i] >> 3 != 0;
    return n;
}

/* One step. Everything moves toward where the engine and the project say it should be; a hit rings a plant's stem, flashes
 * its head, rings the ground and, hard, throws petals. With motion still nothing moves: every value lands at its rest. */
static inline void gd_step(gd_t *g, const gd_in_t *in)
{
    uint32_t dt = in->now - g->last, epoch = in->step / GD_MUTATE_STEPS;
    int moving = 0;
    if (!g->started) {                               /* the first look: the counters as they stand are no hits */
        for (int i = 0; i < GD_N; i++)
            g->pl[i].seen = in->hit[i];
        g->epoch = (uint16_t)epoch;
        g->step = in->step;
        for (int j = 0; j < GD_NF; j++) {
            uint32_t h = gd_hash(g->wseed, 0xF1F1u + (uint32_t)j);
            g->fl[j].x = (int16_t)((h & 255u) * 15u), g->fl[j].y = (int16_t)(16 * (28 + (int)(h >> 8 & 63u)));
        }
        g->started = 1;
    }
    dt = dt < 1u ? 1u : dt > 100u ? 100u : dt;
    for (int i = 0; i < GD_N; i++) {
        gd_plant_t *p = &g->pl[i];
        unsigned n = gd_hits(in->hit[i], &p->seen);
        int solo = in->solo >> i & 1, wilt_to = (in->mute >> i & 1) && !solo ? 255 : 0, lift_to = solo ? 255 : 0,
            grow_to = g->alive >> i & 1 ? 255 : 0, open_to = in->cut[i] * 2 > 255 ? 255 : in->cut[i] * 2;
        if (in->still) {                             /* it rests: what the project says, and not a hit */
            p->bend = p->spin = 0;
            p->pulse = p->halo = p->ripple = 0;
            p->wilt = (uint8_t)wilt_to, p->lift = (uint8_t)lift_to, p->grow = (uint8_t)grow_to, p->open = (uint8_t)open_to;
            p->pan = in->pan[i];
            continue;
        }
        if (n) {
            int v = in->vel[i] ? in->vel[i] : 1, kick = v * 32 * (p->seen & 1u ? 1 : -1), spin = p->spin + kick;
            p->spin = (int16_t)(spin > 8000 ? 8000 : spin < -8000 ? -8000 : spin);
            if (p->pulse < v * 2)
                p->pulse = (uint8_t)(v * 2);
            p->ripple = 255;
            if (v >= 100)
                gd_burst(g, i, v);
        }
        p->pulse = (uint8_t)(p->pulse > dt * 255u / 420u + 1u ? p->pulse - (dt * 255u / 420u + 1u) : 0u);
        p->ripple = (uint8_t)(p->ripple > dt * 255u / 700u + 1u ? p->ripple - (dt * 255u / 700u + 1u) : 0u);
        p->halo = (uint8_t)gd_ease8(p->halo, in->lvl[i], dt, in->lvl[i] > p->halo ? 60u : 450u);
        p->open = (uint8_t)gd_ease8(p->open, open_to, dt, 160u);
        p->wilt = (uint8_t)gd_ease8(p->wilt, wilt_to, dt, 500u);
        p->lift = (uint8_t)gd_ease8(p->lift, lift_to, dt, 400u);
        p->grow = (uint8_t)gd_ease8(p->grow, grow_to, dt, 700u);
        p->pan = (int8_t)gd_ease8(p->pan, in->pan[i], dt, 200u);
        moving |= p->bend || p->spin;
    }
    if (in->still) {
        for (int i = 0; i < GD_NP; i++)
            g->plo[i] = 0;
        g->g_kind = g->g_amt = 0;
        g->aur = 96;
        for (int k = 0; k < 4; k++)
            g->gene[k] = (uint16_t)(g->gene_to[k] << 8);
        g->sub = 0;
        g->step = in->step;
        g->last = in->now;
        return;
    }
    g->sub = (uint8_t)(moving ? g->sub + dt : 0u);   /* the stems ring on 8 ms steps whatever the frame's length */
    for (unsigned s = g->sub / 8u; s; s--)
        for (int i = 0; i < GD_N; i++) {
            gd_plant_t *p = &g->pl[i];
            int b = p->bend, v = p->spin;
            v -= b / 2;
            v -= v / 16;
            b += v / 16;
            if (b > -4 && b < 4 && v > -40 && v < 40)
                b = v = 0;
            p->bend = (int16_t)(b > 3500 ? 3500 : b < -3500 ? -3500 : b);
            p->spin = (int16_t)v;
        }
    g->sub = (uint8_t)(g->sub % 8u);
    for (int i = 0; i < GD_NP; i++) {                /* petals and pollen */
        gd_part_t *q = &g->pt[i];
        unsigned life = g->plo[i] >> 3, drop = (dt + 16u) / 33u;
        if (!life)
            continue;
        q->x = (int16_t)(q->x + q->vx), q->y = (int16_t)(q->y + q->vy);
        q->vx = (int8_t)(q->vx - q->vx / 8), q->vy = (int8_t)(q->vy - q->vy / 16 + 1);
        life = life > drop ? life - drop : 0u;
        if (q->y > 108 * 16)
            life = 0;
        g->plo[i] = (uint8_t)(life << 3 | (g->plo[i] & 7u));
    }
    if (in->live) {                                  /* the fireflies drift toward the brightest plant, else wander */
        int top = -1;
        unsigned best = 24u;
        gd_geo_t o = {0};
        for (int i = 0; i < GD_N; i++)
            if (gd_act(g, i) > best)
                best = gd_act(g, i), top = i;
        if (top >= 0)
            gd_geom(g, top, &o);
        for (int j = 0; j < GD_NF; j++) {
            gd_fly_t *f = &g->fl[j];
            uint32_t h = gd_hash(g->wseed + (uint32_t)j, in->now >> 9);
            int ax, ay, vx, vy;
            if (top >= 0) {
                ax = (o.hx + (int)(h & 255u) - 128 - f->x) / 64;
                ay = (o.hy + (int)(h >> 8 & 255u) - 192 - f->y) / 64;
                ax = ax > 3 ? 3 : ax < -3 ? -3 : ax, ay = ay > 3 ? 3 : ay < -3 ? -3 : ay;
            } else {
                ax = ((int)(h & 3u) - (int)(h >> 2 & 3u)) / 2;
                ay = ((int)(h >> 4 & 3u) - (int)(h >> 6 & 3u)) / 2;
            }
            vx = f->vx - f->vx / 4 + ax, vy = f->vy - f->vy / 4 + ay;
            f->vx = (int8_t)vx, f->vy = (int8_t)vy;
            f->x = (int16_t)(f->x + f->vx), f->y = (int16_t)(f->y + f->vy);
            if (f->x < 0 || f->x > 239 * 16)
                f->vx = (int8_t)-f->vx, f->x = f->x < 0 ? 0 : (int16_t)(239 * 16);
            if (f->y < 20 * 16 || f->y > 104 * 16)
                f->vy = (int8_t)-f->vy, f->y = f->y < 20 * 16 ? (int16_t)(20 * 16) : (int16_t)(104 * 16);
        }
    }
    g->aur = (uint8_t)gd_ease8(g->aur, 56 + in->master * 150 / 255, dt, in->master > g->aur ? 150u : 600u);
    if (epoch > g->epoch && in->playing) {           /* one gene mutates every few bars, and eases there */
        int k = (int)(epoch & 3u);
        g->ne[k]++;
        gd_genes_to(g, k);
    }
    g->epoch = (uint16_t)epoch;
    for (int k = 0; k < 4; k++) {
        int d = (g->gene_to[k] << 8) - g->gene[k], s = d * (int)(dt * 256u / 1800u) / 256;
        if (d && !s)
            s = d > 0 ? 1 : -1;
        g->gene[k] = (uint16_t)(g->gene[k] + s);
    }
    if (g->g_kind) {                                 /* a glitch runs out its own envelope, even when the song stops */
        unsigned age = (uint16_t)((uint16_t)in->now - g->g_t0);
        if (age >= g->g_dur)
            g->g_kind = g->g_amt = 0;
        else
            g->g_amt = (uint8_t)gd_env(age, g->g_dur);
    }
    if (in->step >> 2 != g->step >> 2 && in->playing && !g->g_kind) {   /* a beat went by: maybe a glitch */
        uint32_t beat = in->step >> 2;
        int k = gd_pick(g->wseed, beat, in->level);
        if (k != GK_NONE && gd_flash_ok(g, in->now)) {
            g->g_kind = (uint8_t)k;
            g->g_t0 = (uint16_t)in->now;
            g->g_dur = (uint16_t)gd_glitch_ms(g->wseed, beat);
            g->g_amt = 0;
            gd_flash_note(g, in->now);
        }
    }
    g->step = in->step;
    g->last = in->now;
}

/* The page's picture changes when this does: the state at the resolution the picture shows it, and the clock of what drifts
 * (deco: the page's animation clock, which stands while nothing sounds) */
static inline uint32_t gd_sig(const gd_t *g, uint32_t h, uint32_t deco)
{
    for (int i = 0; i < GD_N; i++) {
        const gd_plant_t *p = &g->pl[i];
        h = gd_hash(h, (uint32_t)(p->bend >> 6 & 0x3FF) | (uint32_t)p->pulse >> 3 << 10 | (uint32_t)p->open >> 4 << 15 |
                       (uint32_t)p->halo >> 3 << 19 | (uint32_t)p->ripple >> 3 << 24);
        h = gd_hash(h, (uint32_t)p->wilt >> 3 | (uint32_t)p->lift >> 3 << 5 | (uint32_t)p->grow >> 3 << 10 |
                       (uint32_t)(uint8_t)p->pan >> 2 << 15);
    }
    for (int i = 0; i < GD_NP; i++)
        if (g->plo[i] >> 3)
            h = gd_hash(h, (uint32_t)(g->pt[i].x >> 4 & 0x1FF) | (uint32_t)(g->pt[i].y >> 4 & 0x1FF) << 9 |
                           (uint32_t)(g->plo[i] >> 4) << 18);
    for (int j = 0; j < GD_NF; j++)
        h = gd_hash(h, (uint32_t)(g->fl[j].x >> 4 & 0x1FF) | (uint32_t)(g->fl[j].y >> 4 & 0x1FF) << 9);
    for (int k = 0; k < 4; k++)
        h = gd_hash(h, g->gene[k] >> 9);
    return gd_hash(gd_hash(h, (uint32_t)g->aur >> 2 | (uint32_t)g->g_kind << 8 | (uint32_t)g->g_amt >> 3 << 12 | (deco >> 7) << 17),
                   g->wseed);
}
