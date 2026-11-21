/* SPDX-License-Identifier: MPL-2.0 */
/* The sub-pixel drawing and the springs (app/gfx_soundplant.c): a shape or a line of text moved by a sixteenth of a pixel
 * keeps its ink and its centre moves by that sixteenth (so it fades from one pixel to the next); a whole-pixel
 * position draws as the integer primitive; a spring lands where it should whatever the frame time. The canvas is the
 * real one (base/device/gfx.c over gfx_soundplant.c); the fonts are the generated ones (tools/gen_font.py). */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define __attribute__(x)
#define APP_CANVAS_PX (240u * 60u)
static void lcd_sync(void) {}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px) { (void)x, (void)y, (void)w, (void)h, (void)px; }
#include "gfx.c"
#define RES_TAG(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)
static uint32_t res_rd32(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static const uint8_t *res_section(uint32_t t, uint32_t *len) { (void)t; *len = 0; return NULL; }
static const char *gfx_audit_where(void) { return "gfx_test"; }
#include "gfx_soundplant.c"

static int bad;
static void check(const char *what, int ok)
{
    printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    bad |= !ok;
}

#define W 140
#define H 48
static const uint16_t WHITE_G = 63u << 5;            /* green at its most: coverage reads as g / 63 */
static void clear(void) { soundplant_begin(W, H, C_BLACK); }
static uint32_t green(int x, int y) { return (swap16(cv_px[y * W + x]) >> 5) & 63u; }

/* the ink drawn, in pixels (each pixel's green over 63; a partly covered pixel's cut-off half step added back), and
 * its centre */
typedef struct { double ink, cx, cy; int partial; } ink_t;
static ink_t measure(void)
{
    ink_t m = {0, 0, 0, 0};
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            uint32_t g = green(x, y);
            double v;
            if (!g)
                continue;
            v = (g < 63u ? (double)g + 0.5 : 63.0) / 63.0;
            m.partial += g < 63u;
            m.ink += v, m.cx += v * (x + 0.5), m.cy += v * (y + 0.5);
        }
    m.cx /= m.ink, m.cy /= m.ink;
    return m;
}

static void test_rectf(void)
{
    int worst_ink = 0, worst_cx = 0, worst_cy = 0;
    int exact = 1;
    for (int k = 0; k < 16; k++) {
        const int w = 20 * 16 + 5, h = 9 * 16 + 7;   /* 20.31 x 9.44 px */
        ink_t a, b;
        clear();
        cv_rectf(10 * 16 + k, 5 * 16, w, h, WHITE_G);
        a = measure();
        clear();
        cv_rectf(10 * 16, 5 * 16 + k, w, h, WHITE_G);
        b = measure();
        if (fabs(a.ink - w * h / 256.0) > a.partial * 0.5 / 63.0 + 0.01 || fabs(b.ink - w * h / 256.0) > b.partial * 0.5 / 63.0 + 0.01)
            worst_ink = 1;
        if (fabs(a.cx - (10.0 + k / 16.0 + w / 32.0)) > 0.02)
            worst_cx = 1;
        if (fabs(b.cy - (5.0 + k / 16.0 + h / 32.0)) > 0.02)
            worst_cy = 1;
    }
    check("cv_rectf: every sixteenth of a pixel keeps the area (to the blend's own rounding)", !worst_ink);
    check("cv_rectf: its centre moves by the offset, in x", !worst_cx);
    check("cv_rectf: its centre moves by the offset, in y", !worst_cy);
    for (int k = 0; k < 4; k++) {                    /* a whole-pixel place is cv_rect's */
        static uint16_t ref[W * H];
        clear();
        cv_rect(7 + k, 3, 25, 11, WHITE_G);
        memcpy(ref, cv_px, sizeof ref);
        clear();
        cv_rectf((7 + k) * 16, 3 * 16, 25 * 16, 11 * 16, WHITE_G);
        exact &= !memcmp(ref, cv_px, sizeof ref);
    }
    check("cv_rectf: a whole-pixel place is byte-identical to cv_rect", exact);
    clear();
    cv_rectf(8, 16, 16 * 16, 16 * 16, WHITE_G);     /* 16 px wide, half a pixel in: the edge columns at half */
    check("cv_rectf: half a pixel in lights the edge pixels at half", green(0, 1) == 31u && green(1, 1) == 63u && green(16, 1) == 31u && green(17, 1) == 0);
    clear();
    cv_rectf(-40, -40, 200 * 16, 200 * 16, WHITE_G);
    check("cv_rectf: bigger than and off the canvas is clipped, whole", green(0, 0) == 63u && green(W - 1, H - 1) == 63u);
}

static void test_pillf(void)
{
    int ok_area = 1, ok_shape = 1, ok_int = 1;
    double base = 0;
    for (int k = 0; k < 16; k++) {
        const int w = 30 * 16, h = 14 * 16, r = 7 * 16;   /* a pill */
        ink_t a;
        clear();
        cv_pillf(10 * 16 + k, 5 * 16 + k, w, h, r, WHITE_G);
        a = measure();
        if (!k)
            base = a.ink;
        if (fabs(a.ink - base) > 1.2)
            ok_area = 0;
        if (fabs(a.cx - (10.0 + k / 16.0 + 15.0)) > 0.03 || fabs(a.cy - (5.0 + k / 16.0 + 7.0)) > 0.03)
            ok_shape = 0;
    }
    /* the pill's area: a 30 x 14 box with its four corners cut to a 7 px radius */
    check("cv_pillf: the area is the pill's (30 x 14, radius 7) within 1 %", fabs(base - (30.0 * 14.0 - (4.0 - M_PI) * 49.0)) < 4.2);
    check("cv_pillf: a sixteenth of a pixel at a time keeps the area", ok_area);
    check("cv_pillf: its centre moves by the offset", ok_shape);
    clear();
    cv_pillf(10 * 16, 5 * 16, 30 * 16, 14 * 16, 0, WHITE_G);
    {
        static uint16_t ref[W * H];
        memcpy(ref, cv_px, sizeof ref);
        clear();
        cv_rect(10, 5, 30, 14, WHITE_G);
        ok_int &= !memcmp(ref, cv_px, sizeof ref);
    }
    check("cv_pillf: radius 0 is the rectangle", ok_int);
    clear();
    cv_pillf(10 * 16, 5 * 16, 30 * 16, 14 * 16, 7 * 16, WHITE_G);
    check("cv_pillf: the corner is rounded (its first pixel stays dark) and the middle is whole",
          green(10, 5) < 20u && green(25, 12) == 63u && green(12, 12) == 63u);
}

static void test_add(void)
{
    clear();
    cv_rect(0, 0, 4, 1, RGB(120, 120, 120));
    cv_add(0, 0, RGB(255, 255, 255), 256);
    cv_add(1, 0, RGB(0, 0, 0), 256);
    cv_add(2, 0, RGB(255, 255, 255), 128);
    check("cv_add: a colour added to a light pixel stops at white, black adds nothing, half adds half",
          swap16(cv_px[0]) == 0xFFFFu && swap16(cv_px[1]) == RGB(120, 120, 120) &&
              (swap16(cv_px[2]) >> 11) == (RGB(120, 120, 120) >> 11) + 15u);
}

static void text_at(int x16, int y16, const soundplant_font_t *f, const char *s)
{
    clear();
    soundplant_text_f(x16, y16, f, s, WHITE_G);
}
static void test_text(void)
{
    static const soundplant_font_t *const FACES[2] = {&LFONT_S, &LFONT_L};
    static const char *const NAMES[2] = {"face S", "face L"};
    for (int f = 0; f < 2; f++) {
        const soundplant_font_t *face = FACES[f];
        ink_t a0, ak;
        int ink_ok = 1, cx_ok = 1, cy_ok = 1;
        char what[96];
        text_at(4 * 16, 4 * 16, face, "Wave 12");
        a0 = measure();
        for (int k = 1; k < 16; k++) {
            text_at(4 * 16 + k, 4 * 16, face, "Wave 12");
            ak = measure();
            if (fabs(ak.ink - a0.ink) > 0.015 * a0.ink)
                ink_ok = 0;
            if (fabs((ak.cx - a0.cx) - k / 16.0) > 0.04 || fabs(ak.cy - a0.cy) > 0.04)
                cx_ok = 0;
            text_at(4 * 16, 4 * 16 + k, face, "Wave 12");
            ak = measure();
            if (fabs(ak.ink - a0.ink) > 0.015 * a0.ink)
                ink_ok = 0;
            if (fabs((ak.cy - a0.cy) - k / 16.0) > 0.04 || fabs(ak.cx - a0.cx) > 0.04)
                cy_ok = 0;
        }
        snprintf(what, sizeof what, "soundplant_text_f %s: every sixteenth of a pixel, either way, keeps the ink within 1.5 %%", NAMES[f]);
        check(what, ink_ok);
        snprintf(what, sizeof what, "soundplant_text_f %s: the ink's centre moves by the offset, in x", NAMES[f]);
        check(what, cx_ok);
        snprintf(what, sizeof what, "soundplant_text_f %s: the ink's centre moves by the offset, in y", NAMES[f]);
        check(what, cy_ok);
    }
    {
        static uint16_t p0[W * H], p1[W * H], pi[W * H];
        int32_t end;
        text_at(4 * 16, 4 * 16, &LFONT_S, "Wave 12");
        memcpy(p0, cv_px, sizeof p0);
        clear();
        end = soundplant_text(4, 4, &LFONT_S, "Wave 12", WHITE_G);
        memcpy(pi, cv_px, sizeof pi);
        check("soundplant_text is soundplant_text_f at a whole pixel, and returns the pen's whole end", !memcmp(p0, pi, sizeof p0) && end == 4 + soundplant_text_w(&LFONT_S, "Wave 12"));
        text_at(5 * 16, 4 * 16, &LFONT_S, "Wave 12");
        memcpy(p1, cv_px, sizeof p1);
        text_at(4 * 16 + 16, 4 * 16, &LFONT_S, "Wave 12");
        check("soundplant_text_f: sixteen sixteenths is the next pixel, exactly", !memcmp(p1, cv_px, sizeof p1));
        text_at(4 * 16 + 8, 4 * 16, &LFONT_S, "Wave 12");
        check("soundplant_text_f: half a pixel is neither of its neighbours", memcmp(p0, cv_px, sizeof p0) && memcmp(p1, cv_px, sizeof p1));
    }
    {
        int clipped_ok;
        clear();
#ifdef GFX_AUDIT
        ga_on = 0;                                   /* (the audit would report the clip it is asked for) */
#endif
        soundplant_text_f(-3 * 16 - 5, -2 * 16 - 9, &LFONT_L, "Wave 12", WHITE_G);   /* partly off the canvas, fractionally */
        clipped_ok = measure().ink > 1.0;
        check("soundplant_text_f: text over the canvas's edge is clipped, not lost", clipped_ok);
    }
}

static void test_spring(void)
{
    spring_t a = {0, 0, 40}, b = {0, 0, 40}, c = {0, 0, 40};
    double worst = 0;
    int mono = 1, moving, still = 0;
    for (int i = 0; i < 4; i++)                      /* 64 ms in 16 ms, in 8 ms, and in one step */
        spring_step(&a, 0.016f, 40.0f);
    for (int i = 0; i < 8; i++)
        spring_step(&b, 0.008f, 40.0f);
    spring_step(&c, 0.064f, 40.0f);
    worst = fmax(fabs(a.x - b.x), fabs(a.x - c.x));
    check("spring: 64 ms in frames of 16, of 8 and in one lands on the same place (within 1e-3 px)", worst < 1e-3);
    check("spring: the velocity agrees too", fabs(a.v - b.v) < 0.05 && fabs(a.v - c.v) < 0.05);
    {
        spring_t s = {0, 0, 40};                     /* from rest it only ever approaches */
        double prev = 0;
        for (int i = 0; i < 100; i++) {
            moving = spring_step(&s, 0.016f, 22.0f);
            mono &= s.x >= prev - 1e-6 && s.x <= 40.0f + 1e-6;
            prev = s.x;
            if (!moving && !still)
                still = i + 1;
        }
        check("spring: from rest it never passes its target", mono);
        check("spring: 40 px at rate 22 is settled within 0.6 s, and exactly on its target", still > 0 && still * 0.016 < 0.6 && s.x == 40.0f && s.v == 0.0f);
    }
    {
        spring_t s = {0, 0, 40};
        int n = 0;
        while (spring_step(&s, 0.016f, 40.0f) && n < 100)
            n++;
        check("spring: 40 px at rate 40 is settled within 0.3 s", n * 0.016 < 0.3 && s.x == 40.0f);
    }
    {
        spring_t s = {0, 0, 100};                    /* retargeted back at its fastest: it turns without passing the new target */
        double over = 0;
        for (int i = 0; i < 4; i++)
            spring_step(&s, 0.016f, 22.0f);
        s.to = 0.0f;
        for (int i = 0; i < 100; i++) {
            spring_step(&s, 0.016f, 22.0f);
            if (s.x < over)
                over = s.x;
        }
        check("spring: a retarget back the way it came ends on the target, the overshoot under the speed over the rate",
              s.x == 0.0f && -over < 1.2 * 200.0 / 22.0 + 0.5);
    }
    {
        spring_t s = {5, 0, 5};
        check("spring: at its target it is still, and stays", !spring_step(&s, 0.016f, 40.0f) && s.x == 5.0f);
    }
}

static void test_ring(void)
{
    double worst = 0, over = 0;
    int signs = 0, last = 0, rest_at = 0;
    for (int ms = 0; ms <= 700; ms++) {              /* a pluck of 3 px, 7 Hz, tau 120 ms */
        double want = 3.0 * exp(-ms / 120.0) * sin(2.0 * M_PI * 7.0 * ms * 0.001), got = ring_at((float)ms, 3.0f, 7.0f, 120.0f);
        double env = 3.0 * exp(-ms / 120.0);
        if (env >= 0.03)                             /* (under 1/32 px the form is cut to nothing) */
            worst = fmax(worst, fabs(got - want));
        over = fmax(over, fabs(got) - env);
        if (got != 0.0 && ms > 0) {
            int sg = got > 0.0 ? 1 : -1;
            signs += sg != last && last != 0;
            last = sg;
            rest_at = ms;
        }
    }
    check("ring_at: it is the decaying sine, e^(-t/tau) sin(2 pi f t), to 1e-3 px", worst < 1e-3);
    check("ring_at: it never passes its envelope", over < 1e-4);
    check("ring_at: it rings (the sign turns over and over before it rests), unlike a critically damped spring", signs >= 3);
    check("ring_at: 3 px at tau 120 ms moves to 553 ms (where the envelope meets 1/32 px) and is exactly 0 after it", rest_at >= 540 && rest_at <= 554);
    check("ring_at: before the pluck (negative time) it is 0, and a negated pluck mirrors it",
          ring_at(-5.0f, 3.0f, 7.0f, 120.0f) == 0.0f && ring_at(40.0f, -3.0f, 7.0f, 120.0f) == -ring_at(40.0f, 3.0f, 7.0f, 120.0f));
}

static uint32_t lcg(uint32_t *s) { return *s = *s * 1664525u + 1013904223u; }

static void test_scope(void)
{
    static int16_t ring[256];
    const uint32_t mask = 255u, span = 256u - SC_GUARD;
    int oracle_ok = 1, range_ok = 1, edge_ok = 1;
    uint32_t seed = 7u, w;
    for (uint32_t i = 0; i < 256u; i++)               /* a tone of 40 samples a cycle, written up to w = 1000 */
        ring[i] = 0;
    for (uint32_t i = 0; i < 1000u; i++)
        ring[i & mask] = (int16_t)lround(1000.0 * sin(2.0 * M_PI * i / 40.0 + 0.3));
    {
        uint32_t c = scope_trig(ring, mask, 1000u, 100u);
        check("scope_trig: it lands on a rising zero crossing", ring[(c - 1u) & mask] < 0 && ring[c & mask] >= 0);
        check("scope_trig: with the samples asked for after it, and the newest such crossing (under one cycle past the least)",
              1000u - c >= 100u && 1000u - c < 100u + 40u);
        for (uint32_t i = 1000u; i < 1040u; i++)
            ring[i & mask] = (int16_t)lround(1000.0 * sin(2.0 * M_PI * i / 40.0 + 0.3));
        check("scope_trig: a steady tone starts in the same place a cycle on (the picture holds still)",
              scope_trig(ring, mask, 1040u, 100u) == c + 40u);
    }
    for (int round = 0; round < 400; round++) {      /* the newest crossing in the allowed reach, by the plain scan */
        uint32_t need = 20u + lcg(&seed) % 200u, want = 0, found = 0, c;
        int dc = (int)(lcg(&seed) % 3u) - 1;
        w = lcg(&seed);
        for (uint32_t i = 0; i < 256u; i++)
            ring[i] = (int16_t)((int)(lcg(&seed) >> 20) - 2048 + dc * 900);
        for (c = w - span + 1u; c != w - need + 1u; c++)   /* (c from the oldest, upward: the last hit is the newest) */
            if (ring[(c - 1u) & mask] < 0 && ring[c & mask] >= 0)
                want = c, found = 1;
        c = scope_trig(ring, mask, w, need);
        if (!found)
            want = w - span;
        oracle_ok &= c == want;
        range_ok &= w - c >= need && w - c <= span;
    }
    check("scope_trig: on 400 random rings it is the newest crossing with room (the plain scan agrees), else the oldest start", oracle_ok);
    check("scope_trig: and it never reaches before the oldest allowed sample or past the newest", range_ok);
    for (uint32_t i = 0; i < 256u; i++)
        ring[i] = 0;
    check("scope_trig: silence has no crossing: the oldest start", scope_trig(ring, mask, 5000u, 120u) == 5000u - span);
    for (uint32_t i = 0; i < 256u; i++)
        ring[i] = (int16_t)(i & 1u ? -300 : 300);   /* it rises on every even sample: the newest with room is `need` back, exactly */
    edge_ok &= scope_trig(ring, mask, 4096u, 120u) == 4096u - 120u;
    check("scope_trig: on 300, -300, 300 ... it lands on the rise `need` back (a fall is not a trigger: the odd sample before it is -300)", edge_ok);
    {
        uint32_t big = 0xFFFFFFF0u;                  /* the write count wraps at 2^32, past the ring's size: the indices stay right */
        for (uint32_t i = 0; i < 256u; i++)
            ring[(big - 255u + i) & mask] = (int16_t)lround(1000.0 * sin(2.0 * M_PI * (big - 255u + i) / 40.0));
        uint32_t c = scope_trig(ring, mask, big + 30u, 100u);   /* (the ring written to big; +30 reads 30 old samples as new: still in range) */
        check("scope_trig: across the 32-bit wrap it still returns a start with room, inside the reach", big + 30u - c >= 100u && big + 30u - c <= span);
    }
    check("scope_trig: asking for the most it can give (need = the reach) is the oldest start, not a read past the newest",
          scope_trig(ring, mask, 9000u, span) == 9000u - span);
}

static void test_fade(void)
{
    uint16_t bg = RGB(8, 16, 32), want[3];
    int mono = 1, first = 0;
    for (int k = 0; k < 3; k++) {
        clear();
        cv_rect(0, 0, W, H, RGB(200, 120, 248));
        cv_fade(bg, k == 0 ? 0u : k == 1 ? 16u : 32u);
        want[k] = swap16(cv_px[3 * W + 3]);
    }
    check("cv_fade: 0/32 is the ground exactly, 32/32 leaves the picture as it was",
          want[0] == bg && want[2] == RGB(200, 120, 248));
    check("cv_fade: 16/32 is halfway in each channel (within one step of 5-6-5)",
          abs((int)(want[1] >> 11) - (int)(((bg >> 11) + (RGB(200, 120, 248) >> 11)) / 2u)) <= 1 &&
              abs((int)(want[1] >> 5 & 63u) - (int)(((bg >> 5 & 63u) + (RGB(200, 120, 248) >> 5 & 63u)) / 2u)) <= 1);
    for (uint32_t a = 0; a < 32; a++) {
        uint32_t g;
        clear();
        cv_rect(0, 0, W, H, WHITE_G);
        cv_fade(C_BLACK, a);
        g = green(5, 5);
        if (g < (uint32_t)first)
            mono = 0;
        first = (int)g;
    }
    check("cv_fade: the picture's share only grows with a", mono);
}

static void test_glow(void)
{
    int sym = 1, dark_out = 1, shift = 1;
    clear();
    cv_glow(30.0f, 20.0f, 8.0f, WHITE_G, 256u);
    for (int d = 1; d < 8; d++)
        if (green(29 - d, 19) != green(30 + d, 20) && green(29 - d, 19) != green(30 + d, 19))
            sym = 0;
    check("cv_glow: the same light either side of its centre", sym);
    check("cv_glow: brightest at the centre and falling with distance", green(29, 19) > green(26, 19) && green(26, 19) > green(23, 19) &&
                                                                       green(23, 19) > 0u);
    for (int j = 0; j < H; j++)
        for (int i = 0; i < W; i++)
            if (((float)i + 0.5f - 30.0f) * ((float)i + 0.5f - 30.0f) + ((float)j + 0.5f - 20.0f) * ((float)j + 0.5f - 20.0f) >= 64.0f &&
                green(i, j))
                dark_out = 0;
    check("cv_glow: nothing past its radius", dark_out);
    for (int k = 0; k < 16; k++) {
        ink_t m;
        clear();
        cv_glow(30.0f + (float)k / 16.0f, 20.0f, 8.0f, WHITE_G, 256u);
        m = measure();
        if (fabs(m.cx - (30.0 + k / 16.0)) > 0.06)
            shift = 0;
    }
    check("cv_glow: a sixteenth of a pixel at a time moves its centre by as much", shift);
    clear();
    cv_rect(0, 0, W, H, WHITE_G);
    cv_glow(30.0f, 20.0f, 8.0f, WHITE_G, 256u);
    check("cv_glow: added to a full pixel it stays full (no wrap)", green(30, 20) == 63u);
}

static void test_beam(void)
{
    uint32_t mid, near1, far3;
    clear();
    cv_beam(40.5f, 4, 40, WHITE_G, WHITE_G, 128u);
    mid = green(40, 22), near1 = green(42, 22), far3 = green(44, 22);
    check("cv_beam: the core is at full colour on its column", mid == 63u);
    check("cv_beam: the halo falls off each side and is gone by four pixels", near1 > far3 && near1 > 0u && green(45, 22) == 0u &&
                                                                              green(35, 22) == 0u);
    check("cv_beam: both ends taper (the first row is dimmer than the middle, the row past the end is dark)",
          green(40, 4) < mid && green(40, 3) == 0u && green(40, 40) == 0u);
    clear();
    cv_beam(40.5f, 4, 40, WHITE_G, WHITE_G, 128u);
    {
        uint32_t a = green(39, 22) + green(40, 22) + green(41, 22);
        clear();
        cv_beam(40.9f, 4, 40, WHITE_G, WHITE_G, 128u);
        check("cv_beam: a sub-pixel move shifts the light across the neighbouring columns",
              green(41, 22) > green(39, 22) && a > 0u);
    }
}

static void test_line_a(void)
{
    uint32_t top = 0, full = 0;
    uint16_t ref[W * H];
    clear();
    cv_line_a(10.0f, 10.0f, 100.0f, 30.0f, WHITE_G, 5.0f, 0, 64u);
    for (int i = 0; i < W * H; i++)
        top = top > (swap16(cv_px[i]) >> 5 & 63u) ? top : (swap16(cv_px[i]) >> 5 & 63u);
    check("cv_line_a: a halo at 64/256 never lights a pixel past a quarter", top > 0u && top <= 16u);
    clear();
    cv_line_a(10.0f, 10.0f, 100.0f, 30.0f, WHITE_G, 1.7f, 0, 256u);
    memcpy(ref, cv_px, sizeof ref);
    clear();
    cv_line_ex(10.0f, 10.0f, 100.0f, 30.0f, WHITE_G, 1.7f, 0);
    check("cv_line_ex is cv_line_a at full strength, byte for byte", !memcmp(ref, cv_px, sizeof ref));
    clear();
    cv_line_ex(10.0f, 10.0f, 100.0f, 30.0f, WHITE_G, 1.7f, 0);
    for (int i = 0; i < W * H; i++)
        full += (swap16(cv_px[i]) >> 5 & 63u) == 63u;
    check("cv_line_ex: the core reaches full colour", full > 40u);
}

static void test_palette_measures(void)
{
    uint16_t white = RGB(255, 255, 255), black = RGB(0, 0, 0), red = RGB(255, 0, 0), grey = RGB(128, 128, 128);
    check("ga_contrast: white on black is 21:1, a colour on itself 1:1",
          fabs(ga_contrast(white, black) - 21.0) < 0.05 && fabs(ga_contrast(red, red) - 1.0) < 1e-9);
    check("ga_contrast: the same either way round", ga_contrast(red, grey) == ga_contrast(grey, red));
    check("ga_contrast: pure red on white is the known 4.0:1, pure blue on white 8.59:1",
          fabs(ga_contrast(red, white) - 4.0) < 0.01 && fabs(ga_contrast(RGB(0, 0, 255), white) - 8.59) < 0.02);
    check("ga_contrast: mid grey (the 5-6-5 one nearest 128) on white is 3.84:1 (the gamma curve's middle)",
          fabs(ga_contrast(grey, white) - 3.8365) < 0.01);
    check("ga_contrast: a nearer colour reads lower", ga_contrast(RGB(40, 40, 40), black) < ga_contrast(RGB(160, 160, 160), black));
    check("ga_delta_e: black to white is 100, a colour to itself 0",
          fabs(ga_delta_e(black, white) - 100.0) < 0.5 && ga_delta_e(red, red) == 0.0);
    check("ga_delta_e: pure red and green are the known 170.6 apart (CIE76, D65)", fabs(ga_delta_e(red, RGB(0, 255, 0)) - 170.6) < 1.0);
    check("ga_delta_e: blue and yellow are 235.2 apart (the b axis's scale), mid grey from black 54.4 (the gamma curve's middle)",
          fabs(ga_delta_e(RGB(0, 0, 255), RGB(255, 255, 0)) - 235.16) < 0.5 && fabs(ga_delta_e(grey, black) - 54.44) < 0.3);
    check("ga_delta_e: the same either way round, and a near colour is nearer than a far one",
          ga_delta_e(red, grey) == ga_delta_e(grey, red) && ga_delta_e(red, RGB(240, 0, 0)) < ga_delta_e(red, RGB(120, 0, 0)));
}

int main(void)
{
    test_rectf();
    test_pillf();
    test_add();
    test_text();
    test_spring();
    test_ring();
    test_scope();
    test_fade();
    test_glow();
    test_beam();
    test_line_a();
    test_palette_measures();
    printf(bad ? "gfx_test: FAILED\n" : "gfx_test: all ok\n");
    return bad;
}
