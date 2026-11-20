/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Charles Vestal. Its text drawing (soundplant_glyph, soundplant_text_w, soundplant_text_box, soundplant_text's blending)
 * is fm1-base's device/gfx.c, Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments, under MPL-2.0
 * as there (felucca-bsp#4) */
/* SoundPlant's drawing over fm1-base's canvas (base/device/gfx.c: cv_px, cv_begin, cv_rect, cv_blit, the palette):
 * its own fonts in a compact format (each glyph its ink box only, the big faces run-length coded: tools/gen_font.py,
 * a third of fm1-base's), anti-aliased lines and dots, and on the host the layout audit (GFX_AUDIT). Included first by
 * app.c; from its end on, the app's FONT_*, cv_text, text_w, draw_text_box, cv_begin and cv_line are these (the
 * platform's own screens, compiled before the app, keep fm1-base's). */
typedef struct {               /* proportional, see tools/gen_font.py */
    uint8_t h;
    uint8_t pad;               /* bitmap starts this many pixels left of the pen */
    uint8_t first, last;
    uint8_t rle;               /* 1: the nibbles code runs of 0 and 15; 2: Huffman-coded alphas (gen_font.py) */
    const uint8_t *adv;        /* advance per glyph */
    const uint8_t (*box)[4];   /* ink box per glyph: x (from FONT_PAD left of the pen), y, w, h */
    const uint16_t *off;       /* byte offset of each glyph's nibbles */
    const uint8_t *data;
} soundplant_font_t;
#include "fastmath.h"
#include "soundplant_font.h"

#if defined PLAT_HOST && !defined PLAT_WEB
#define GFX_AUDIT 1                                  /* the layout audit: LAYOUT lines on stdout (host.c counts them) */
#endif
#ifdef GFX_AUDIT
#include <math.h>
/* host only: the layout audit. Within one picture (a canvas, or the bands of a taller picture, pic_next: judged in the
 * picture's own rows, once, in its first band), a label's ink must stay inside the picture, must not touch another
 * label's ink, and must not cross the edge of a rounded box (wholly in or wholly out). A picture drawn in bands is
 * drawn once more (band 0) and must come out the same (a page's drawing may change nothing but the canvas).
 * Findings print once each as "LAYOUT ..." with where the app is (gfx_audit_where, the host's). */
static const char *gfx_audit_where(void);
typedef struct { int32_t x0, y0, x1, y1; char s[24]; } ga_box_t;
static ga_box_t ga_txt[96], ga_rnd[160];
static uint32_t ga_ntxt, ga_nrnd, ga_seen[512], ga_nseen, ga_findings;
static int32_t ga_margin;                            /* SOUNDPLANT_MARGIN=N (host.c): labels N px apart, and from boxes' edges */
static int32_t ga_pic_h;                             /* the rows of the picture being drawn */
static int ga_on = 1;                                /* 0: a band the audit has seen (the picture's later bands) */
static int ga_hold;                                  /* 1: a picture with things in motion (cut by a window, between
                                                      * places): not audited, its rest is */
#define GA_HOLD(v) (ga_hold = (v))
/* the palette audit's measures, on 5-6-5 colours: the WCAG contrast ratio (1 .. 21) and the CIE76 distance in Lab
 * (0 .. 100 from black to white) */
static double ga_lin(uint32_t v, uint32_t max)
{
    double s = (double)v / (double)max;
    return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4);
}
static void ga_xyz(uint16_t c, double *x, double *y, double *z)
{
    double r = ga_lin(c >> 11, 31u), g = ga_lin(c >> 5 & 63u, 63u), b = ga_lin(c & 31u, 31u);
    *x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    *y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    *z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
}
static double ga_contrast(uint16_t a, uint16_t b)
{
    double x, ya, yb, z;
    ga_xyz(a, &x, &ya, &z);
    ga_xyz(b, &x, &yb, &z);
    return (fmax(ya, yb) + 0.05) / (fmin(ya, yb) + 0.05);
}
static void ga_lab(uint16_t c, double *l, double *a, double *b)
{
    double x, y, z, f[3];
    const double *v[3] = {&x, &y, &z};
    ga_xyz(c, &x, &y, &z);
    for (int i = 0; i < 3; i++)
        f[i] = *v[i] > 0.008856 ? cbrt(*v[i]) : 7.787 * *v[i] + 16.0 / 116.0;
    *l = 116.0 * f[1] - 16.0, *a = 500.0 * (f[0] - f[1]), *b = 200.0 * (f[1] - f[2]);
}
static double ga_delta_e(uint16_t p, uint16_t q)
{
    double l0, a0, b0, l1, a1, b1;
    ga_lab(p, &l0, &a0, &b0);
    ga_lab(q, &l1, &a1, &b1);
    return sqrt((l0 - l1) * (l0 - l1) + (a0 - a1) * (a0 - a1) + (b0 - b1) * (b0 - b1));
}
static void ga_reset(void) { ga_ntxt = ga_nrnd = 0; }
static void ga_report(const char *what, const char *a, const char *b, int32_t x, int32_t y)
{
    uint32_t h = 2166136261u;
    const char *w = gfx_audit_where(), *q;
    if (!ga_on)
        return;
    for (q = what; *q; q++) h = (h ^ (uint8_t)*q) * 16777619u;
    for (q = a; *q; q++) h = (h ^ (uint8_t)*q) * 16777619u;
    for (q = b; *q; q++) h = (h ^ (uint8_t)*q) * 16777619u;
    for (q = w; *q; q++) h = (h ^ (uint8_t)*q) * 16777619u;
    for (uint32_t i = 0; i < ga_nseen; i++)
        if (ga_seen[i] == h)
            return;
    if (ga_nseen < 512)
        ga_seen[ga_nseen++] = h;
    ga_findings++;
    printf("LAYOUT %s: \"%s\"%s%s%s at %d,%d (%s)\n", what, a, *b ? " / \"" : "", b, *b ? "\"" : "", (int)x, (int)y, w);
}
static void ga_text(const char *s, int32_t x0, int32_t y0, int32_t x1, int32_t y1, int clipped)
{
    ga_box_t *t;
    uint32_t i;
    if (x1 < x0 || !ga_on)
        return;                                      /* no ink (spaces) */
    if (clipped)
        ga_report("CLIPPED", s, "", x0, y0);
    else if (cv_w == 240u && (x0 < 2 || x1 > 237))   /* a full-width band: ink right at the glass's edge */
        ga_report("AT THE SCREEN EDGE", s, "", x0, y0);
    for (i = 0; i < ga_ntxt; i++) {
        ga_box_t *o = &ga_txt[i];
        if (x0 <= o->x1 && o->x0 <= x1 && y0 <= o->y1 && o->y0 <= y1)
            ga_report("OVERLAP", s, o->s, x0, y0);
        else if (ga_margin && x0 <= o->x1 + ga_margin && o->x0 <= x1 + ga_margin && y0 <= o->y1 + ga_margin &&
                 o->y0 <= y1 + ga_margin)
            ga_report("TOO CLOSE", s, o->s, x0, y0);   /* (SOUNDPLANT_MARGIN=N: closer than N px to another label) */
    }
    for (i = 0; i < ga_nrnd; i++) {
        ga_box_t *r = &ga_rnd[i];
        int inside = x0 >= r->x0 && x1 <= r->x1 && y0 >= r->y0 && y1 <= r->y1;
        int apart = x1 < r->x0 || x0 > r->x1 || y1 < r->y0 || y0 > r->y1;
        if (!inside && !apart)
            ga_report("CROSSES A BOX EDGE", s, "", x0, y0);
        else if (inside && (x0 < r->x0 + 1 || x1 > r->x1 - 1 || y0 < r->y0 + 1 || y1 > r->y1 - 1)
                 && (r->x1 - r->x0 > 16 || r->y1 - r->y0 > 16))   /* (a tiny chip may hug its label) */
        {
            char bx[40];
            snprintf(bx, sizeof bx, "ink %d..%d,%d..%d box %d..%d,%d..%d", (int)x0, (int)x1, (int)y0, (int)y1, (int)r->x0,
                     (int)r->x1, (int)r->y0, (int)r->y1);
            ga_report("TOUCHES A BOX EDGE", s, bx, x0, y0);
        }
    }
    if (ga_ntxt < 96) {
        t = &ga_txt[ga_ntxt++];
        t->x0 = x0, t->y0 = y0, t->x1 = x1, t->y1 = y1;
        for (i = 0; i < sizeof t->s - 1u && s[i]; i++)
            t->s[i] = s[i];
        t->s[i] = 0;
    }
}
static void gfx_audit_box(int32_t x, int32_t y, int32_t w, int32_t h)
{
    if (ga_on && ga_nrnd < 160 && w > 0 && h > 0) {
        ga_box_t *r = &ga_rnd[ga_nrnd++];
        r->x0 = x, r->y0 = y, r->x1 = x + w - 1, r->y1 = y + h - 1, r->s[0] = 0;
        for (uint32_t i = 0; i < ga_ntxt; i++) {     /* a box drawn after a label: over it, or (SOUNDPLANT_MARGIN) close */
            const ga_box_t *t = &ga_txt[i];
            int inside = t->x0 >= r->x0 && t->x1 <= r->x1 && t->y0 >= r->y0 && t->y1 <= r->y1;
            int apart = t->x1 < r->x0 || t->x0 > r->x1 || t->y1 < r->y0 || t->y0 > r->y1;
            int near = t->x1 + ga_margin < r->x0 || t->x0 - ga_margin > r->x1 || t->y1 + ga_margin < r->y0 ||
                       t->y0 - ga_margin > r->y1;
            if (!inside && !apart)
                ga_report("BOX OVER A LABEL", t->s, "", t->x0, t->y0);
            else if (apart && !near && ga_margin && (r->x1 - r->x0 > 3 && r->y1 - r->y0 > 3))
                ga_report("TOO CLOSE TO A BOX", t->s, "", t->x0, t->y0);
        }
    }
}
#else
#define GA_HOLD(v) ((void)0)
#endif

static void soundplant_begin(uint32_t w, uint32_t h, uint16_t bg)   /* fm1-base's cv_begin, and a new canvas to audit */
{
#ifdef GFX_AUDIT
    if (w * h > CV_MAX) {                            /* (cv_begin cuts it to the canvas: a picture this tall is drawn in bands) */
        char sz[24];
        snprintf(sz, sizeof sz, "%u x %u", (unsigned)w, (unsigned)h);
        ga_report("CANVAS TOO TALL", sz, "", 0, 0);
    }
#endif
    cv_begin(w, h, bg);
#ifdef GFX_AUDIT
    ga_reset();
    ga_on = !ga_hold;
    ga_pic_h = (int32_t)cv_h;
#endif
}

/* a picture taller than the canvas, 240 px wide, at screen row y and h rows, drawn in bands the canvas holds:
 *     for (pic_begin(y, h, bg); pic_next(); pic_send()) { draw the whole picture }
 * The body runs once a band, the canvas on rows [row, row + rows) of the picture (cv_oy, cv_y0, cv_y1: drawing
 * outside them is clipped, a draw call wholly outside them costs next to nothing), its rows sent when it ends
 * (`continue` ends a band early). It runs more than once, so it may change nothing but the canvas: a page's state
 * moves before it, in the page's own function. The host draws band 0 once more and finds a body that did not. */
/* the canvas a/32 of the way from the colour bg to what it holds (a page fading up; 5-6-5 fields spread over a word, one
 * multiply a pixel) */
static void cv_fade(uint16_t bg, uint32_t a)
{
    uint32_t b = ((uint32_t)bg | (uint32_t)bg << 16) & 0x07E0F81Fu;
    for (uint32_t i = 0; i < cv_w * cv_h; i++) {
        uint32_t p = swap16(cv_px[i]), q = (p | p << 16) & 0x07E0F81Fu;
        q = (q * a + b * (32u - a)) >> 5 & 0x07E0F81Fu;
        cv_px[i] = swap16((uint16_t)(q | q >> 16));
    }
}
typedef struct { int32_t y, h, row, rows, rise; uint32_t fade; uint16_t bg; int again; } pic_t;
static pic_t pic;
static int32_t pic_rise_req;                         /* the next picture is drawn this many rows lower (a page rising in) ... */
static uint32_t pic_fade_req = 32;                   /* ... and shown a/32 of the way from its ground (32: as it is) */
#ifdef GFX_AUDIT
static uint16_t ga_first[CV_MAX];                    /* band 0 as it was drawn the first time */
#endif
static void pic_begin(int32_t y, int32_t h, uint16_t bg)
{
    pic.y = y, pic.h = h, pic.row = pic.rows = pic.again = 0, pic.bg = bg;
    pic.rise = pic_rise_req, pic.fade = pic_fade_req;
    pic_rise_req = 0, pic_fade_req = 32;
}
static int pic_next(void)
{
    int32_t rows = (int32_t)(CV_MAX / 240u);
    if (pic.row >= pic.h)
        return 0;
    if (pic.h - pic.row < rows)
        rows = pic.h - pic.row;
    cv_begin(240, (uint32_t)rows, pic.bg);
    cv_oy = -pic.row + pic.rise, cv_y0 = 0, cv_y1 = rows;
    pic.rows = rows;
#ifdef GFX_AUDIT
    ga_on = !pic.row && !pic.again && !ga_hold && !pic.rise;
    if (ga_on) {
        ga_reset();
        ga_pic_h = pic.h;
    }
#endif
    return 1;
}
static void pic_send(void)
{
#ifdef GFX_AUDIT
    if (pic.again) {                                 /* band 0 the second time: not sent, as it was */
        for (uint32_t i = 0; i < cv_w * cv_h; i++)
            if (cv_px[i] != ga_first[i]) {
                ga_on = 1;
                ga_report("DRAWS DIFFERENTLY THE SECOND TIME", "band 0", "", (int32_t)(i % cv_w), (int32_t)(i / cv_w));
                break;
            }
        pic.row = pic.h;
        return;
    }
    if (!pic.row)
        memcpy(ga_first, cv_px, cv_w * cv_h * sizeof cv_px[0]);
#endif
    if (pic.fade < 32u)
        cv_fade(pic.bg, pic.fade);
    cv_blit(0, (uint32_t)(pic.y + pic.row));
    pic.row += pic.rows;
#ifdef GFX_AUDIT
    if (pic.row >= pic.h)
        pic.row = 0, pic.again = 1;
#endif
}

/* colour c over the pixel at a/256 (anti-aliased drawing) */
static void cv_blend(int32_t x, int32_t y, uint16_t c, uint32_t a)
{
    uint32_t bg, r, g, b;
    y += cv_oy;
    if ((uint32_t)x >= cv_w || y < cv_y0 || y >= cv_y1 || !a)
        return;
    if (a >= 256u) {
        cv_px[(uint32_t)y * cv_w + (uint32_t)x] = swap16(c);
        return;
    }
    bg = swap16(cv_px[(uint32_t)y * cv_w + (uint32_t)x]);
    r = ((c >> 11) * a + (bg >> 11) * (256u - a)) >> 8;
    g = ((c >> 5 & 63u) * a + (bg >> 5 & 63u) * (256u - a)) >> 8;
    b = ((c & 31u) * a + (bg & 31u) * (256u - a)) >> 8;
    cv_px[(uint32_t)y * cv_w + (uint32_t)x] = swap16((uint16_t)(r << 11 | g << 5 | b));
}

static int32_t f_floor(float v) { int32_t i = (int32_t)v; return v < (float)i ? i - 1 : i; }
static float f_abs(float v) { return v < 0.0f ? -v : v; }
static float f_sqrt1(float v)                   /* sqrt for v >= 1 (Newton, a few steps: line slopes) */
{
    float r = v < 2.0f ? 1.2f : v * 0.5f;
    for (int i = 0; i < 6; i++)
        r = 0.5f * (r + v / r);
    return r;
}

/* an anti-aliased line w pixels wide between sub-pixel points: along its long axis, each step lights the few
 * pixels across it by their distance from the line. The long axis is half-open: the line's own end (whichever way it
 * runs) is the next segment's first, so a polyline of short segments blends each pixel once. end_only: just that end
 * column (a polyline turning from one long axis to the other draws it: the next segment, walking the other axis, would
 * leave a notch there). am: the line's most opaque, 0 .. 256 (a halo). Returns 1 if it walked y. */
static int cv_line_a(float x0, float y0, float x1, float y1, uint16_t c, float w, int end_only, uint32_t am)
{
    float dx = x1 - x0, dy = y1 - y0, hw = w * 0.5f, m = (hw + 1.0f) * 1.5f + 2.0f;   /* (m: past the line's reach) */
    int steep = f_abs(dy) > f_abs(dx), back = 0;
    float k, cs, reach;
    int32_t a, e, from, to;
    if ((y0 < y1 ? y1 : y0) + m < (float)(cv_y0 - cv_oy) || (y0 < y1 ? y0 : y1) - m > (float)(cv_y1 - cv_oy) ||
        (x0 < x1 ? x1 : x0) + m < 0.0f || (x0 < x1 ? x0 : x1) - m > (float)cv_w)
        return steep;                            /* wholly off the canvas (a band of the picture: the next one's) */
    if (steep) {                                 /* walk y: swap the axes */
        float t;
        t = x0, x0 = y0, y0 = t;
        t = x1, x1 = y1, y1 = t;
        t = dx, dx = dy, dy = t;
    }
    if (dx < 0.0f) {                             /* walk it forwards (its end is then the first column) */
        float t;
        t = x0, x0 = x1, x1 = t;
        t = y0, y0 = y1, y1 = t;
        dx = -dx, dy = -dy;
        back = 1;
    }
    k = dx > 1e-4f ? dy / dx : 0.0f;
    cs = 1.0f / f_sqrt1(1.0f + k * k);           /* across the line, per pixel of the short axis */
    reach = (hw + 1.0f) / cs;
    a = f_floor(x0 + 0.5f);
    e = f_floor(x1 + 0.5f);
    if (e == a)
        e = a + 1;
    from = back ? a + 1 : a;                     /* [start, end): the end column left out */
    to = back ? e : e - 1;
    if (end_only)
        from = to = back ? a : e;
    for (int32_t i = from; i <= to; i++) {
        float yc = y0 + ((float)i - x0) * k;
        int32_t j0 = f_floor(yc - reach), j1 = f_floor(yc + reach) + 1;
        for (int32_t j = j0; j <= j1; j++) {
            float cov = hw + 0.5f - f_abs((float)j - yc) * cs;
            if (cov <= 0.0f)
                continue;
            if (cov > 1.0f)
                cov = 1.0f;
            if (steep)
                cv_blend(j, i, c, (uint32_t)(cov * (float)am));
            else
                cv_blend(i, j, c, (uint32_t)(cov * (float)am));
        }
    }
    return steep;
}
static int cv_line_ex(float x0, float y0, float x1, float y1, uint16_t c, float w, int end_only)
{
    return cv_line_a(x0, y0, x1, y1, c, w, end_only, 256u);
}
static void cv_linef(float x0, float y0, float x1, float y1, uint16_t c, float w)
{
    cv_line_ex(x0, y0, x1, y1, c, w, 0);
}

/* a soft round dot of radius r at a sub-pixel point */
static void cv_dotf(float x, float y, float r, uint16_t c)
{
    int32_t x0 = f_floor(x - r - 1.0f), x1 = f_floor(x + r + 1.0f), y0 = f_floor(y - r - 1.0f), y1 = f_floor(y + r + 1.0f);
    if (y1 + cv_oy < cv_y0 || y0 + cv_oy >= cv_y1)
        return;
    for (int32_t j = y0; j <= y1; j++)
        for (int32_t i = x0; i <= x1; i++) {
            float ddx = (float)i - x, ddy = (float)j - y, d2 = ddx * ddx + ddy * ddy, cov;
            if (d2 > (r + 1.0f) * (r + 1.0f))
                continue;
            cov = r + 0.5f - (d2 > 1.0f ? f_sqrt1(d2) : d2);
            if (cov > 0.0f)
                cv_blend(i, j, c, cov >= 1.0f ? 256u : (uint32_t)(cov * 256.0f));
        }
}

/* the integer line: anti-aliased, a little over a pixel wide */
static void soundplant_line(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint16_t c)
{
    cv_linef((float)x0, (float)y0, (float)x1, (float)y1, c, 1.5f);
}

/* ---- sub-pixel drawing: positions and sizes in 1/16 pixel. A pixel an edge falls inside takes the colour at the
 * share of it the shape covers (x share times y share, 0 .. 256: cv_blend's alpha), so a shape moving by a sixteenth
 * of a pixel is a visible step in the two pixels it moves between. Whole-pixel shapes draw as cv_rect does. These
 * are not boxes for the layout audit (they are what moves; a label drawn over them is judged by the text rules). */
static uint32_t cov16(int32_t lo, int32_t hi, int32_t i)   /* of pixel i, the share [lo, hi) covers, 0 .. 16 */
{
    int32_t a = i * 16, b = a + 16;
    if (lo > a)
        a = lo;
    if (hi < b)
        b = hi;
    return b > a ? (uint32_t)(b - a) : 0u;
}
static void cv_rectf(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c)
{
    int32_t x1 = x + w, y1 = y + h, i0 = x >> 4, i1 = (x1 + 15) >> 4, j0 = y >> 4, j1 = (y1 + 15) >> 4;
    int32_t fx0 = (x + 15) >> 4, fx1 = x1 >> 4, fy0 = (y + 15) >> 4, fy1 = y1 >> 4;   /* the pixels covered whole */
    if (w <= 0 || h <= 0)
        return;
    if (fx1 > fx0 && fy1 > fy0)
        cv_rect(fx0, fy0, fx1 - fx0, fy1 - fy0, c);
    if (i0 < 0)
        i0 = 0;
    if (i1 > (int32_t)cv_w)
        i1 = (int32_t)cv_w;
    if (j0 < cv_y0 - cv_oy)
        j0 = cv_y0 - cv_oy;
    if (j1 > cv_y1 - cv_oy)
        j1 = cv_y1 - cv_oy;
    for (int32_t j = j0; j < j1; j++) {
        uint32_t cy = cov16(y, y1, j);
        for (int32_t i = i0; i < i1; i++) {
            if (j >= fy0 && j < fy1 && i >= fx0 && i < fx1) {
                i = fx1 - 1;                         /* (the whole pixels were filled above) */
                continue;
            }
            cv_blend(i, j, c, cov16(x, x1, i) * cy);
        }
    }
}

/* a rounded box at a fractional place, radius r: the straight parts as cv_rectf (their edges meet on whole pixels, so
 * no pixel is blended twice), the corners (r rounded up to whole pixels) pixel by pixel by their distance from the
 * shape's edge */
static void cv_pillf(int32_t x, int32_t y, int32_t w, int32_t h, int32_t r, uint16_t c)
{
    int32_t ix0 = x >> 4, ix1 = (x + w + 15) >> 4, iy0 = y >> 4, iy1 = (y + h + 15) >> 4;
    int32_t rr = (r + 15) >> 4;
    float hx = (float)w * (1.0f / 32.0f), hy = (float)h * (1.0f / 32.0f), cx = (float)x * (1.0f / 16.0f) + hx,
          cy = (float)y * (1.0f / 16.0f) + hy, rf = (float)r * (1.0f / 16.0f);
    if (w <= 0 || h <= 0)
        return;
    if (rr > (ix1 - ix0) / 2)
        rr = (ix1 - ix0) / 2;
    if (rr > (iy1 - iy0) / 2)
        rr = (iy1 - iy0) / 2;
    if (rr < 1) {
        cv_rectf(x, y, w, h, c);
        return;
    }
    cv_rectf(x, (iy0 + rr) * 16, w, (iy1 - iy0 - 2 * rr) * 16, c);
    cv_rectf((ix0 + rr) * 16, y, (ix1 - ix0 - 2 * rr) * 16, (iy0 + rr) * 16 - y, c);
    cv_rectf((ix0 + rr) * 16, (iy1 - rr) * 16, (ix1 - ix0 - 2 * rr) * 16, y + h - (iy1 - rr) * 16, c);
    if (!(iy0 + rr + cv_oy > cv_y0 && iy0 + cv_oy < cv_y1) && !(iy1 + cv_oy > cv_y0 && iy1 - rr + cv_oy < cv_y1))
        return;                                      /* (the canvas shows neither pair of corners) */
    for (int32_t k = 0; k < 4; k++) {
        int32_t bx = k & 1 ? ix1 - rr : ix0, by = k & 2 ? iy1 - rr : iy0;
        for (int32_t j = by; j < by + rr; j++)
            for (int32_t i = bx; i < bx + rr; i++) {
                float qx = f_abs((float)i + 0.5f - cx) - (hx - rf), qy = f_abs((float)j + 0.5f - cy) - (hy - rf), d, cov;
                if (qx > 0.0f && qy > 0.0f) {
                    float d2 = qx * qx + qy * qy;
                    d = (d2 > 1.0f ? f_sqrt1(d2) : d2) - rf;
                } else
                    d = (qx > qy ? qx : qy) - rf;
                cov = 0.5f - d;
                if (cov > 0.0f)
                    cv_blend(i, j, c, cov >= 1.0f ? 256u : (uint32_t)(cov * 256.0f));
            }
    }
}

/* colour c added to the pixel at a/256, each channel up to its most (glows: where two overlap they brighten) */
static void cv_add(int32_t x, int32_t y, uint16_t c, uint32_t a)
{
    uint32_t bg, r, g, b;
    y += cv_oy;
    if ((uint32_t)x >= cv_w || y < cv_y0 || y >= cv_y1 || !a)
        return;
    bg = swap16(cv_px[(uint32_t)y * cv_w + (uint32_t)x]);
    r = (bg >> 11) + ((c >> 11) * a >> 8);
    g = (bg >> 5 & 63u) + ((c >> 5 & 63u) * a >> 8);
    b = (bg & 31u) + ((c & 31u) * a >> 8);
    cv_px[(uint32_t)y * cv_w + (uint32_t)x] = swap16((uint16_t)((r > 31u ? 31u : r) << 11 | (g > 63u ? 63u : g) << 5 | (b > 31u ? 31u : b)));
}

/* a soft round glow at a sub-pixel point: colour c added at peak/256 in the middle, falling off with the square of the
 * distance to nothing at radius r */
static void cv_glow(float x, float y, float r, uint16_t c, uint32_t peak)
{
    int32_t x0 = f_floor(x - r), x1 = f_floor(x + r) + 1, y0 = f_floor(y - r), y1 = f_floor(y + r) + 1;
    float r2 = r * r;
    if (y1 + cv_oy < cv_y0 || y0 + cv_oy >= cv_y1)
        return;
    for (int32_t j = y0; j <= y1; j++)
        for (int32_t i = x0; i <= x1; i++) {
            float dx = (float)i + 0.5f - x, dy = (float)j + 0.5f - y, t = 1.0f - (dx * dx + dy * dy) / r2;
            if (t > 0.0f)
                cv_add(i, j, c, (uint32_t)(t * t * (float)peak));
        }
}

/* a lit vertical line at a sub-pixel x over rows y0 .. y1: a core a pixel and a half wide in colour core, a halo of
 * colour halo added each side (up to peak/256, fading over four pixels), both tapering to nothing over the last four
 * rows at each end */
static void cv_beam(float x, int32_t y0, int32_t y1, uint16_t core, uint16_t halo, uint32_t peak)
{
    int32_t i0 = f_floor(x - 4.0f), i1 = f_floor(x + 4.0f), j0 = y0 > cv_y0 - cv_oy ? y0 : cv_y0 - cv_oy,
            j1 = y1 < cv_y1 - cv_oy ? y1 : cv_y1 - cv_oy;
    for (int32_t i = i0; i <= i1; i++) {
        float d = f_abs((float)i + 0.5f - x), t = 1.0f - d * 0.25f, cc = 1.25f - d;
        uint32_t ha = t > 0.0f ? (uint32_t)(t * t * t * (float)peak) : 0u, ca = cc > 0.0f ? (uint32_t)((cc > 1.0f ? 1.0f : cc) * 256.0f) : 0u;
        for (int32_t j = j0; j < j1; j++) {
            int32_t e = j - y0 + 1 < y1 - j ? j - y0 + 1 : y1 - j;
            uint32_t k = e >= 4 ? 4u : (uint32_t)e;
            cv_add(i, j, halo, ha * k / 4u);
            cv_blend(i, j, core, ca * k / 4u);
        }
    }
}

/* ---- motion: a value that follows its target, critically damped (no overshoot, the fastest approach that has none).
 * Stepped in closed form, so the result depends on the time that passed and not on how many frames it took: a frame
 * that comes late lands where the quick ones would have. w is the rate (1/s: 40 is a settle in about 120 ms), dt in
 * seconds. At rest (within 1/32 px and slow) the value is the target, exactly: whole pixels, a crisp picture. */
typedef struct { float x, v, to; } spring_t;
static int spring_step(spring_t *s, float dt, float w)   /* -> still moving */
{
    float e = s->x - s->to, k = s->v + w * e, ex = fm_expf(-w * dt);
    s->x = s->to + (e + k * dt) * ex;
    s->v = (s->v - w * k * dt) * ex;
    if (f_abs(s->x - s->to) < 0.03f && f_abs(s->v) < 0.5f) {
        s->x = s->to, s->v = 0.0f;
        return 0;
    }
    return 1;
}

/* glyph index of a character: lower case folds to upper case when the font
 * has none, anything missing (and C1 controls) draws as '?' */
static uint32_t soundplant_glyph(const soundplant_font_t *f, uint32_t ch)
{
    if (ch >= 'a' && ch <= 'z' && f->last < 'a')
        ch -= 32u;
    if (ch < f->first || ch > f->last || (ch >= 127u && ch < 160u))
        ch = '?';
    return ch - f->first;
}

/* the next alpha of a Huffman-coded glyph (rle 2, gen_font.py huff_face): t the code for the alpha before (the counts of
 * each length 1..12, then the alphas in code order), d the face's data, *bit the next bit's index */
static uint32_t soundplant_alpha(const uint8_t *t, const uint8_t *d, uint32_t *bit)
{
    uint32_t len, code = 0, first = 0, at = 0;
    for (len = 0; len < 12u; len++) {
        uint32_t n = t[len];
        code |= (uint32_t)(d[*bit >> 3] >> (7u - (*bit & 7u))) & 1u;
        ++*bit;
        if (code - first < n)
            return t[12u + at + code - first];
        at += n;
        first = (first + n) << 1;
        code <<= 1;
    }
    return 0;
}

/* text in colour c at a position in 1/16 pixels, each pixel's coverage blended over what is already on the canvas (an
 * anti-aliased face on a coloured box gets no dark fringe). A fractional position spreads each glyph pixel over the
 * four it overlaps (bilinear: the ink is kept, its centre moves by the fraction); at a whole pixel it is the glyph as
 * drawn. Returns the end x in 1/16 pixels (soundplant_text: whole pixels) */
static int32_t soundplant_track;                           /* letters this much closer (a label a few pixels too wide: 1) */
#define GL_W 48u                                     /* a glyph's width limit: its two source rows (the faces' widest is 25) */
static int32_t soundplant_text_f(int32_t x16, int32_t y16, const soundplant_font_t *f, const char *s, uint16_t c)
{
    uint32_t r = c >> 11, g = (c >> 5) & 63u, b = c & 31u, fx = (uint32_t)x16 & 15u, fy = (uint32_t)y16 & 15u;
    int32_t x = x16 >> 4, y = y16 >> 4;
    uint8_t rows[2][GL_W + 1];
#ifdef GFX_AUDIT
    const char *s0 = s;
    int32_t ix0 = 1 << 20, iy0 = 1 << 20, ix1 = -(1 << 20), iy1 = -(1 << 20), clip = 0, shown = 0;
#endif
    for (; *s; s++) {
        uint32_t gi = soundplant_glyph(f, (uint8_t)*s), gx, gy, w, bh, nib = 0, run = 0, a = 0, nc, nr;
        const uint8_t *gd = f->data + f->off[gi], *bx = f->box[gi];
        int32_t x0 = x - f->pad + bx[0], y0 = y + bx[1] + cv_oy;
        uint8_t *cur = rows[0], *prev = rows[1];
        w = bx[2];
        bh = bx[3];
        nc = w + (fx ? 1u : 0u);                     /* (a shifted glyph reaches one column and one row further) */
        nr = bh + (fy ? 1u : 0u);
        if (w >= GL_W) {
            x += f->adv[gi] - (s[1] ? soundplant_track : 0);
            continue;
        }
#ifndef GFX_AUDIT                                    /* (the audit reads every glyph's ink) */
        if (y0 >= cv_y1 || y0 + (int32_t)nr <= cv_y0 || x0 >= (int32_t)cv_w || x0 + (int32_t)nc <= 0) {
            x += f->adv[gi] - (s[1] ? soundplant_track : 0);   /* wholly off the canvas, a band of the picture */
            continue;
        }
#endif
        memset(prev, 0, w + 1u);
        for (gy = 0; gy < nr; gy++) {
            for (gx = 0; gx < w; gx++) {
                if (gy >= bh) {
                    cur[gx] = 0;
                    continue;
                }
                if (f->rle == 2u) {                  /* (Huffman: the code for the alpha before; bits from the glyph's) */
                    if (!gx && !gy)
                        nib = (uint32_t)f->off[gi] * 8u, a = 0;
                    a = soundplant_alpha(f->data + 28u * (a == 0 ? 0u : a == 15u ? 1u : 2u), f->data, &nib);
                    run = 1;
                } else if (!run) {                   /* the next nibble: a pixel, or a run of them */
                    a = (nib & 1u) ? gd[nib >> 1] & 15u : gd[nib >> 1] >> 4;
                    nib++;
                    run = 1;
                    if (f->rle && (a == 0 || a == 15u)) {
                        run += (nib & 1u) ? gd[nib >> 1] & 15u : gd[nib >> 1] >> 4;
                        nib++;
                    }
                }
                run--;
                cur[gx] = (uint8_t)a;
            }
            cur[w] = 0;
            for (gx = 0; gx < nc; gx++) {            /* the row's pixels: each the four source pixels it overlaps */
                int32_t px = x0 + (int32_t)gx, py = y0 + (int32_t)gy;
                uint32_t cv = cur[gx], cl = gx ? cur[gx - 1u] : 0u, pv = prev[gx], pl = gx ? prev[gx - 1u] : 0u, A;
                A = (fx | fy) ? (16u - fx) * (16u - fy) * cv + fx * (16u - fy) * cl + (16u - fx) * fy * pv + fx * fy * pl
                              : cv << 8;             /* (0 .. 15 * 256) */
#ifdef GFX_AUDIT
                if (A >= 4u * 256u) {                /* ink that shows (the faintest edge pixels aside), in the picture's rows */
                    int32_t ly = py - cv_oy;
                    if (px < ix0) ix0 = px;
                    if (px > ix1) ix1 = px;
                    if (ly < iy0) iy0 = ly;
                    if (ly > iy1) iy1 = ly;
                    if ((uint32_t)px >= cv_w || ly < 0 || ly >= ga_pic_h)
                        clip = 1;
                    else
                        shown = 1;
                }
#endif
                if (!A || (uint32_t)px >= cv_w || py < cv_y0 || py >= cv_y1)
                    continue;
                if (A >= 15u * 256u) {
                    cv_px[(uint32_t)py * cv_w + (uint32_t)px] = swap16(c);
                } else {
                    uint32_t bg = swap16(cv_px[(uint32_t)py * cv_w + (uint32_t)px]);
                    uint32_t br = bg >> 11, bgg = (bg >> 5) & 63u, bb = bg & 31u;
                    uint32_t mr = (r * A + br * (15u * 256u - A)) / (15u * 256u),
                             mg = (g * A + bgg * (15u * 256u - A)) / (15u * 256u),
                             mb = (b * A + bb * (15u * 256u - A)) / (15u * 256u);
                    cv_px[(uint32_t)py * cv_w + (uint32_t)px] = swap16((mr << 11) | (mg << 5) | mb);
                }
            }
            {
                uint8_t *t = cur;
                cur = prev, prev = t;
            }
        }
        x += f->adv[gi] - (s[1] ? soundplant_track : 0);
    }
#ifdef GFX_AUDIT
    if (shown)                                       /* (wholly outside: a list's hidden rows, not drawn) */
        ga_text(s0, ix0, iy0, ix1, iy1, clip);
#endif
    return x * 16 + (int32_t)fx;
}
static int32_t soundplant_text(int32_t x, int32_t y, const soundplant_font_t *f, const char *s, uint16_t c)
{
    return soundplant_text_f(x * 16, y * 16, f, s, c) >> 4;
}

static int32_t soundplant_text_w(const soundplant_font_t *f, const char *s)
{
    int32_t w = 0;
    for (; *s; s++)
        w += f->adv[soundplant_glyph(f, (uint8_t)*s)] - (s[1] ? soundplant_track : 0);
    return w;
}

/* one-shot: text in a box, cleared to black, blitted */
static void soundplant_text_box(uint32_t x, uint32_t y, uint32_t w, const soundplant_font_t *f, const char *s, uint16_t c, int align)
{
    int32_t tw = soundplant_text_w(f, s), tx = 0;
    soundplant_begin(w, f->h, C_BLACK);
    if (align == 1)
        tx = ((int32_t)w - tw) / 2;
    else if (align == 2)
        tx = (int32_t)w - tw;
    soundplant_text(tx, 0, f, s, c);
    cv_blit(x, y);
    lcd_sync();
}

/* fm1-base's own screens in SoundPlant's faces (base/device/sys_text.c, APP_SYS_TEXT): the body, a heading, the big
 * one (the panel's screens: the heading's face, as before) */
static const soundplant_font_t *const SYS_FACE[3] = {&LFONT_S, &LFONT_B, &LFONT_B};
static int32_t app_sys_h(int face) { return SYS_FACE[face]->h; }
static int32_t app_sys_w(int face, const char *s) { return soundplant_text_w(SYS_FACE[face], s); }
static void app_sys_text(int32_t x, int32_t y, int face, const char *s, uint16_t c) { soundplant_text(x, y, SYS_FACE[face], s, c); }

/* large type (Setup > SEL > LARGE TYPE): the roles' faces one size up or more, the larger ones from the resource region
 * (tools/gen_font.py LARGE: 18 px semibold for XS's labels, 20 px for S's and B's), the values L's 31 px; without the
 * region (not yet written after an update) the faces built in. The hints keep the small face (LFONT_XS): they are
 * hints. soundplant_type(1) switches every FONT_* below at once */
static soundplant_font_t lt_face[3];
static uint8_t lt_ok, lt_on;
static uint16_t lt_rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static void soundplant_large_load(void)
{
    uint32_t n, i, cnt;
    const uint8_t *p = res_section(RES_TAG('L', 'F', 'T', '1'), &n);
    lt_ok = 0;
    if (!p || n < 4u || (cnt = lt_rd16(p)) < 3u || n < 4u + 4u * cnt)
        return;
    for (i = 0; i < 3; i++) {
        uint32_t o = res_rd32(p + 4 + 4 * i);
        const uint8_t *f = p + o;
        soundplant_font_t *t = &lt_face[i];
        if (o > n - 24u || ((uintptr_t)f & 3u))
            return;
        t->h = f[0], t->pad = f[1], t->first = f[2], t->last = f[3], t->rle = f[4];
        t->adv = f + res_rd32(f + 8);
        t->box = (const uint8_t (*)[4])(f + res_rd32(f + 12));
        t->off = (const uint16_t *)(f + res_rd32(f + 16));
        t->data = f + res_rd32(f + 20);
        if (t->last < t->first || o + res_rd32(f + 20) > n)
            return;
    }
    lt_ok = 1;
}
static const soundplant_font_t *lt_xs = &LFONT_XS, *lt_s = &LFONT_S, *lt_b = &LFONT_B, *lt_m = &LFONT_M;
static int soundplant_type(int large)                      /* -> large type on (the faces there) */
{
    if (large && !lt_ok)                             /* (written since the start: the installer after an update) */
        soundplant_large_load();
    lt_on = (uint8_t)(large && lt_ok);
    lt_xs = lt_on ? &lt_face[0] : &LFONT_XS;
    lt_s = lt_on ? &lt_face[1] : &LFONT_S;
    lt_b = lt_on ? &lt_face[2] : &LFONT_B;
    lt_m = lt_on ? &LFONT_L : &LFONT_M;
    return lt_on;
}

/* from here on, the app draws with these */
#define felucca_font_t soundplant_font_t
#define FONT_XS (*lt_xs)
#define FONT_S (*lt_s)
#define FONT_B (*lt_b)
#define FONT_M (*lt_m)
#define FONT_L LFONT_L
#define FONT_HINT LFONT_XS                           /* (the hints: small in large type too) */
#define cv_begin soundplant_begin
#define cv_line soundplant_line
#define cv_text soundplant_text
#define text_w soundplant_text_w
#define draw_text_box soundplant_text_box
