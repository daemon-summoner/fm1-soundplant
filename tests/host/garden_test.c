/* SPDX-License-Identifier: MPL-2.0 */
/* The Garden page's state (app/garden.h, which has no screen in it): the glitch schedule is the same for a seed
 * (garden_test.sh checks it against an independent port of the hash: "garden_test schedule" prints it), a glitch
 * begins at most three times in any second (WCAG 2.3.1) and the guard is what holds that, the petals never outnumber
 * their pool and die, a hit counter that wrapped still counts, and a garden at rest (motion still, or nothing sounding)
 * changes nothing from one frame to the next. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "garden.h"

static int bad;
static void check(const char *what, int ok)
{
    printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    bad |= !ok;
}

#define SEED_FIXED 0xC0FFEE11u
#define FRAME_MS 33u                                 /* the state's own step (GD_TICK_MS) */

/* every byte of the state but the clock it keeps and the hit counters it has seen (they move with each look) */
static uint32_t fp(const gd_t *g)
{
    gd_t c = *g;
    const uint8_t *b = (const uint8_t *)&c;
    uint32_t h = 2166136261u;
    c.last = 0, c.step = 0, c.epoch = 0;
    for (int i = 0; i < GD_N; i++)
        c.pl[i].seen = 0;
    for (size_t i = 0; i < sizeof c; i++)
        h = (h ^ b[i]) * 16777619u;
    return h;
}

/* a garden as the page opens it on a project: every track's patterns fed, the first look taken */
static void open_garden(gd_t *g, gd_in_t *in, uint32_t user)
{
    memset(g, 0, sizeof *g);
    for (int t = 0; t < GD_N; t++)
        gd_seed_feed(g, t, 0x1000u + 7u * (uint32_t)t, t < 6, (uint8_t)user);
    memset(in, 0, sizeof *in);
    for (int t = 0; t < GD_N; t++)
        in->cut[t] = 80, in->lvl[t] = 0;
    in->now = 1000;
    in->step = 4;
    gd_step(g, in);
}

/* ---- the schedule, printed for garden_test.sh to hold against its own hash */
static void print_schedule(void)
{
    for (int lvl = GG_SOFT; lvl < GG_N; lvl++)
        for (uint32_t beat = 0; beat < 512; beat++) {
            int k = gd_pick(SEED_FIXED, beat, lvl);
            if (k != GK_NONE)
                printf("%d %u %d %u\n", lvl, (unsigned)beat, k, gd_glitch_ms(SEED_FIXED, beat));
        }
}

/* ---- a song's run: the glitch begins, as (time, kind, duration) */
typedef struct { uint32_t t, beat; int kind; unsigned dur; } begin_t;
#define MAXB 4096
static begin_t bg[MAXB];
static int nb;

/* run SECS seconds of a playing project at STEP_MS a sixteenth, at glitch knob LEVEL. SHORT: end each glitch the frame
 * it begins (a test of the guard alone: the real durations never ask it for much); NOGUARD: forget the guard's
 * record before every frame. Returns the begins in bg[] */
static void run_song(unsigned secs, unsigned step_ms, int level, int shorten, int noguard)
{
    gd_t g;
    gd_in_t in;
    uint32_t t0 = 1000;
    open_garden(&g, &in, 0);
    g.wseed = SEED_FIXED;
    nb = 0;
    in.playing = 1, in.live = 1, in.level = (uint8_t)level;
    for (uint32_t now = t0; now < t0 + secs * 1000u; now += FRAME_MS) {
        uint8_t kind0;
        in.now = now;
        in.step = 4u + (now - t0) / step_ms;
        if (noguard)
            g.nflash = 0;
        kind0 = g.g_kind;
        gd_step(&g, &in);
        if (g.g_kind && !kind0 && nb < MAXB)
            bg[nb++] = (begin_t){now, in.step >> 2, g.g_kind, g.g_dur};
        if (shorten)
            g.g_kind = g.g_amt = 0;
    }
}

static int window_max(void)                          /* the most begins in any 1000 ms (half open) */
{
    int most = 0;
    for (int i = 0; i < nb; i++) {
        int n = 0;
        for (int j = i; j < nb && bg[j].t < bg[i].t + GD_FLASH_MS; j++)
            n++;
        if (n > most)
            most = n;
    }
    return most;
}

static void test_schedule(void)
{
    begin_t first[MAXB];
    int n1, same = 1, apart = 1, matches = 1;
    run_song(120, 125, GG_WILD, 0, 0);               /* 120 BPM, two minutes */
    n1 = nb;
    memcpy(first, bg, sizeof first);
    run_song(120, 125, GG_WILD, 0, 0);
    same = nb == n1 && !memcmp(first, bg, sizeof bg[0] * (size_t)nb);
    for (int i = 0; i < nb; i++) {
        matches &= bg[i].kind == gd_pick(SEED_FIXED, bg[i].beat, GG_WILD) &&
                   bg[i].dur == gd_glitch_ms(SEED_FIXED, bg[i].beat);
        if (i)
            apart &= bg[i].t - bg[i - 1].t >= 360u;
    }
    check("a seed's glitches are the same on a second run (times, kinds, lengths)", n1 > 20 && same);
    check("each glitch is the one its beat's hash picks, as long as it says", matches);
    check("no glitch begins while the last is running (at least 360 ms apart)", apart);

    run_song(120, 125, GG_OFF, 0, 0);
    check("glitch off: none", nb == 0);
    {
        gd_t g;
        gd_in_t in;
        int begun = 0;
        open_garden(&g, &in, 0);
        g.wseed = SEED_FIXED;
        in.playing = 0, in.live = 1, in.level = GG_WILD;
        for (uint32_t now = 1000; now < 61000u; now += FRAME_MS) {
            in.now = now, in.step = 4u + (now - 1000u) / 125u;
            gd_step(&g, &in);
            begun |= g.g_kind;
        }
        check("nothing playing: none (the steps still count)", !begun);
    }
    run_song(120, 125, GG_SOFT, 0, 0);
    {
        int soft = nb;
        run_song(120, 125, GG_WILD, 0, 0);
        check("the knob is a rate: wild glitches more than soft", soft > 0 && nb > soft);
    }
}

static void test_flash(void)
{
    int seen_kinds = 0, w;
    run_song(300, 50, GG_WILD, 0, 0);                /* 300 BPM, the fastest, five minutes */
    w = window_max();
    for (int i = 0; i < nb; i++)
        seen_kinds |= 1 << bg[i].kind;
    check("at 300 BPM, wild, five minutes: some glitches, every kind among them",
          nb > 100 && seen_kinds == (1 << GK_TEAR | 1 << GK_FOLD | 1 << GK_HUE | 1 << GK_DERES));
    check("at 300 BPM, wild: at most 3 begin in any second", w <= (int)GD_FLASH_MAX);
    run_song(300, 50, GG_WILD, 1, 0);
    w = window_max();
    check("the guard alone (glitches ended at once): 3 in a second, not 4", nb > 200 && w == (int)GD_FLASH_MAX);
    run_song(300, 50, GG_WILD, 1, 1);
    w = window_max();
    check("control: with the guard's record wiped every frame, a second holds more than 3", w > (int)GD_FLASH_MAX);

    {                                                /* the guard's own rule, at its edges */
        gd_t g;
        memset(&g, 0, sizeof g);
        check("guard: empty, ok", gd_flash_ok(&g, 5000));
        gd_flash_note(&g, 5000), gd_flash_note(&g, 5100), gd_flash_note(&g, 5200);
        check("guard: three in the last second, not ok", !gd_flash_ok(&g, 5300));
        check("guard: not ok 1 ms short of the oldest's second", !gd_flash_ok(&g, 5999));
        check("guard: ok when the oldest is a second old", gd_flash_ok(&g, 6000));
        memset(&g, 0, sizeof g);
        gd_flash_note(&g, 65000), gd_flash_note(&g, 65100), gd_flash_note(&g, 65200);
        check("guard: not ok across the 16-bit clock's wrap, 1 ms short", !gd_flash_ok(&g, 65000u + 999u));
        check("guard: ok a second on, across the wrap", gd_flash_ok(&g, 65000u + 1000u));
    }
}

/* ---- the petals */
static void test_pool(void)
{
    gd_t g;
    gd_in_t in;
    int most = 0, born_last = 0;
    open_garden(&g, &in, 0);
    in.playing = 1, in.live = 1;
    for (int round = 0; round < 60; round++) {       /* every plant struck hard every frame, velocities to the byte's top */
        for (int t = 0; t < GD_N; t++)
            in.hit[t]++, in.vel[t] = (uint8_t)(round % 3 == 0 ? 255 : 127);
        in.now += FRAME_MS, in.step++;
        gd_step(&g, &in);
        if (gd_particles(&g) > most)
            most = gd_particles(&g);
    }
    check("sixty rounds of eight hard hits: the pool is full and never more", most == GD_NP);
    {
        int lives_ok = 1;
        for (int i = 0; i < GD_NP; i++)
            lives_ok &= g.plo[i] >> 3 != 0 && (g.plo[i] & 7u) < GD_N;
        born_last = lives_ok;
    }
    check("every petal is alive and belongs to a plant (the oldest are taken over)", born_last);
    for (int f = 0; f < 150; f++) {                  /* no hit: they fall and die */
        in.now += FRAME_MS, in.step++;
        gd_step(&g, &in);
    }
    check("five seconds on with no hit: none in the air", gd_particles(&g) == 0);

    open_garden(&g, &in, 0);
    in.playing = 1, in.live = 1;
    in.hit[2]++, in.vel[2] = 60;
    in.now += FRAME_MS, in.step++;
    gd_step(&g, &in);
    check("a soft hit (velocity 60) sheds nothing, and rings the plant", gd_particles(&g) == 0 && g.pl[2].pulse > 0);
    in.hit[2]++, in.vel[2] = 127;
    in.now += FRAME_MS, in.step++;
    gd_step(&g, &in);
    check("a hard hit (127) sheds petals from that plant", gd_particles(&g) >= 2 && (g.plo[0] & 7u) == 2);
}

/* ---- the counters, bytes that wrap */
static void test_wrap(void)
{
    uint8_t seen = 250;
    gd_t g;
    gd_in_t in;
    check("gd_hits: 3 more is 3", gd_hits(253, &seen) == 3 && seen == 253);
    check("gd_hits: no change is none", gd_hits(253, &seen) == 0);
    seen = 254;
    check("gd_hits: 254 to 1, over the wrap, is 3", gd_hits(1, &seen) == 3 && seen == 1);
    seen = 7;
    check("gd_hits: a full turn (256 between two looks) reads as none, the one blind spot", gd_hits(7, &seen) == 0);

    open_garden(&g, &in, 0);
    in.playing = 1, in.live = 1;
    memset(in.hit, 255, sizeof in.hit);              /* the counters stand at 255 when the page opens: no hits */
    memset(&g, 0, sizeof g);
    for (int t = 0; t < GD_N; t++)
        gd_seed_feed(&g, t, 0x1000u + 7u * (uint32_t)t, 1, 0);
    in.now = 2000;
    gd_step(&g, &in);
    check("opened with the counters at 255: no pulse", g.pl[0].pulse == 0 && g.pl[5].pulse == 0);
    in.hit[0] = 0, in.vel[0] = 90;                   /* 255 -> 0 */
    in.now += FRAME_MS;
    gd_step(&g, &in);
    check("one hit over the wrap (255 to 0) rings the plant", g.pl[0].pulse >= 90 && g.pl[1].pulse == 0);
    in.now += FRAME_MS;
    gd_step(&g, &in);
    check("and only once", g.pl[0].pulse < 180 && g.pl[0].ripple < 255);
}

/* ---- at rest, the garden changes nothing */
static void test_rest(void)
{
    gd_t g;
    gd_in_t in;
    uint32_t f0, sig, deco = 7000;
    int moved = 0, sigs = 0;
    open_garden(&g, &in, 0);
    in.still = 1, in.playing = 1, in.live = 1, in.level = GG_WILD;
    for (int f = 0; f < 4; f++) {                    /* a few frames to land (the first leaves the opening's values) */
        in.now += FRAME_MS, in.step += 2;
        gd_step(&g, &in);
    }
    f0 = fp(&g), sig = gd_sig(&g, 1, deco);
    for (int f = 0; f < 300; f++) {                  /* motion still, hits arriving, a song at 300 BPM, wild: nothing moves */
        for (int t = 0; t < GD_N; t++)
            in.hit[t]++, in.vel[t] = 127, in.lvl[t] = 255;
        in.now += FRAME_MS, in.step += 2, in.master = 255;
        gd_step(&g, &in);
        moved |= fp(&g) != f0;
        sigs |= gd_sig(&g, 1, deco) != sig;
    }
    check("still: every byte of the state is the same after 300 frames of hits, a loud song and glitches", !moved);
    check("still: the picture's signature never moves", !sigs);
    check("still: no petal, no glitch", gd_particles(&g) == 0 && g.g_kind == 0);

    open_garden(&g, &in, 0);                         /* silent and not still: it settles, then holds */
    for (int f = 0; f < 200; f++) {
        in.now += FRAME_MS;
        gd_step(&g, &in);
    }
    f0 = fp(&g), sig = gd_sig(&g, 1, deco), moved = 0, sigs = 0;
    for (int f = 0; f < 300; f++) {
        in.now += FRAME_MS;
        gd_step(&g, &in);
        moved |= fp(&g) != f0;
        sigs |= gd_sig(&g, 1, deco) != sig;
    }
    check("nothing sounding: once settled, every byte of the state and the signature hold", !moved && !sigs);

    in.hit[3]++, in.vel[3] = 100;                    /* control: a hit moves it */
    in.now += FRAME_MS;
    gd_step(&g, &in);
    check("control: a hit wakes it (the state and the signature move)", fp(&g) != f0 && gd_sig(&g, 1, deco) != sig);
    open_garden(&g, &in, 0);
    in.still = 1;
    in.now += FRAME_MS;
    gd_step(&g, &in);
    f0 = fp(&g);
    in.still = 0, in.playing = 1, in.live = 1, in.hit[3]++, in.vel[3] = 127;
    in.now += FRAME_MS;
    gd_step(&g, &in);
    check("control: the same hit with motion on moves it", fp(&g) != f0 && g.pl[3].pulse > 0);
}

/* ---- the genes and the plants' moods */
static void test_genes(void)
{
    gd_t a, b, c;
    gd_in_t in;
    uint16_t before[4];
    int mutated = 0, popped = 0, held = 0;
    uint32_t spr = 0;
    open_garden(&a, &in, 0);
    open_garden(&b, &in, 0);
    open_garden(&c, &in, 1);
    check("the same patterns: the same seed and genes", a.seed == b.seed && !memcmp(a.gene, b.gene, sizeof a.gene));
    check("a different SEED knob: another sky and other genes", a.wseed != c.wseed && memcmp(a.gene_to, c.gene_to, 4));
    memcpy(before, a.gene, sizeof before);
    in.playing = 1, in.live = 1;
    for (int f = 0; f < 4000; f++) {                 /* about 130 s at 120 BPM: thirty bars, so seven or eight mutations */
        uint16_t was[4];
        memcpy(was, a.gene, sizeof was);
        in.now += FRAME_MS, in.step = 4u + (in.now - 1000u) / 125u;
        gd_step(&a, &in);
        for (int k = 0; k < 4; k++) {
            int d = (int)a.gene[k] - (int)was[k];
            popped |= d > 1500 || d < -1500;         /* more than 2.3 % of a gene's range in a frame */
            spr += d != 0;
        }
    }
    for (int k = 0; k < 4; k++)
        mutated |= a.gene[k] != before[k];
    check("while playing a gene mutates and eases there", mutated && a.ne[0] + a.ne[1] + a.ne[2] + a.ne[3] >= 6);
    check("no frame moves a gene by more than 1500 of 65535 (it never pops)", !popped && spr > 40);

    open_garden(&b, &in, 0);
    in.playing = 0;
    for (int f = 0; f < 4000; f++) {
        in.now += FRAME_MS, in.step = 4u + (in.now - 1000u) / 125u;
        gd_step(&b, &in);
    }
    held = b.ne[0] + b.ne[1] + b.ne[2] + b.ne[3] == 0;
    check("stopped: the genes stay", held);

    open_garden(&a, &in, 0);
    in.mute = 1 << 2, in.solo = 1 << 5, in.playing = 1, in.live = 1;
    for (int f = 0; f < 90; f++) {
        in.now += FRAME_MS;
        gd_step(&a, &in);
    }
    check("a muted track wilts and a solo lifts, the others stand", a.pl[2].wilt > 240 && a.pl[5].lift > 240 &&
          a.pl[0].wilt == 0 && a.pl[0].lift == 0);
    in.solo |= 1 << 2;
    for (int f = 0; f < 90; f++) {
        in.now += FRAME_MS;
        gd_step(&a, &in);
    }
    check("muted and solo: the solo wins", a.pl[2].wilt == 0 && a.pl[2].lift > 240);
}

int main(int argc, char **argv)
{
    if (argc > 1 && !strcmp(argv[1], "schedule")) {
        print_schedule();
        return 0;
    }
    printf("garden state: %u bytes (gd_t)\n", (unsigned)sizeof(gd_t));
    test_schedule();
    test_flash();
    test_pool();
    test_wrap();
    test_rest();
    test_genes();
    puts(bad ? "garden_test: FAILED" : "garden_test: all passed");
    return bad;
}
