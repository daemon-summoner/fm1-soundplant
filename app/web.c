/* SPDX-License-Identifier: MPL-2.0 */
/* The browser's garden (app/web/emu/garden*.js): the eight tracks' state, packed, for the page. fm1-base's emu_web.c
 * includes this last (app.h APP_WEB), into the app's one translation unit, so it reads the app's statics. It changes
 * nothing but the garden's own peaks: no sound, no screen. The emulator build only. */

#define GARDEN_VERSION 1u

typedef struct {                       /* 32 bytes a track */
    uint8_t engine;                    /* EG_* */
    uint8_t flags;                     /* GF_* */
    uint8_t step, len, lstart, lend;   /* the step playing, the pattern's length and loop */
    uint8_t held;                      /* notes sounding now */
    uint8_t note, vel;                 /* the last hit's (a kit: its sound 0..10) */
    uint8_t vol, pan, cut, res;        /* 0..127, as the knobs; the lock's value while one holds */
    uint8_t send1, send2;
    int8_t groove;                     /* -99..99 */
    uint16_t peak;                     /* the loudest block since the last read, Q14 (to 2) */
    uint16_t hits;                     /* every hit counted (wraps) */
    uint8_t pat, scale;
    uint8_t rsv[2];
    uint64_t mask;                     /* bit k: step k of the pattern has notes */
} garden_trk_t;
enum { GF_MUTE = 1, GF_SOLO = 2, GF_SOLO_ON = 4 };   /* muted; soloed; some track is soloed */

typedef struct {                       /* 32 bytes, then the tracks */
    uint16_t version, size;
    uint8_t playing, scene, bar16, song_pos;
    uint16_t tempo_x10, solo;
    uint32_t step_tick;                /* sixteenths since the start */
    uint32_t bar_six;
    uint16_t mute, rsv;
    uint32_t reads;                    /* snapshots taken */
    uint32_t rsv2;
    garden_trk_t trk[NTRK];
} garden_t;
_Static_assert(sizeof(garden_trk_t) == 32, "garden_trk_t: web/emu/garden_core.js reads 32 bytes a track");
_Static_assert(offsetof(garden_trk_t, mask) == 24, "garden_trk_t: mask at 24");
_Static_assert(offsetof(garden_t, trk) == 32 && sizeof(garden_t) == 32 + 32 * NTRK, "garden_t: header 32 bytes");

static garden_t garden;

static uint8_t garden_par(int t, int p)
{
    int v = engine_live(t, p);
    return (uint8_t)(v >= 0 ? v : epar[t][p]);
}

/* the snapshot, in the module's memory: valid until the next call. Reading takes the peaks */
__attribute__((used, visibility("default"))) const uint8_t *web_garden(void)
{
    garden_t *g = &garden;
    g->version = GARDEN_VERSION;
    g->size = (uint16_t)sizeof *g;
    g->playing = seq.playing;
    g->scene = eng_scene_now;
    g->bar16 = seq.bar16;
    g->song_pos = seq.song_pos;
    g->tempo_x10 = (uint16_t)(seq_tempo(&seq) * 10.0f + 0.5f);
    g->solo = ui.solo;
    g->mute = seq.mute;
    g->step_tick = seq.step_tick;
    g->bar_six = seq.bar_six;
    g->reads++;
    for (int t = 0; t < NTRK; t++) {
        garden_trk_t *k = &g->trk[t];
        const tpat_t *p = &pats.pat[t][seq.ppat[t] % NPATT];
        int held = __builtin_popcount(seq.t[t].off_mask);
        uint64_t mask = 0;
        for (int i = 0; i < p->len && i < NSTEP; i++)
            if (!step_empty(&p->st[i]))
                mask |= 1ull << i;
        k->engine = epar[t][TP_ENGINE];
        k->flags = (uint8_t)((seq.mute >> t & 1u ? GF_MUTE : 0) | (ui.solo >> t & 1u ? GF_SOLO : 0) |
                             (ui.solo ? GF_SOLO_ON : 0));
        k->step = eng_step[t];
        k->len = p->len;
        k->lstart = p->lstart;
        k->lend = p->lend;
        k->held = (uint8_t)(held > seq.player[t].nheld ? held : seq.player[t].nheld);
        k->note = web_note[t];
        k->vel = web_vel[t];
        k->vol = garden_par(t, TP_VOLUME);
        k->pan = garden_par(t, TP_PAN);
        k->cut = garden_par(t, TP_CUT);
        k->res = garden_par(t, TP_RES);
        k->send1 = garden_par(t, TP_SEND1);
        k->send2 = garden_par(t, TP_SEND2);
        k->groove = p->groove;
        k->peak = web_peak[t];
        web_peak[t] = 0;
        k->hits = web_hits[t];
        k->pat = seq.ppat[t];
        k->scale = p->scale;
        k->mask = mask;
    }
    return (const uint8_t *)g;
}

__attribute__((used, visibility("default"))) uint32_t web_garden_size(void) { return (uint32_t)sizeof(garden_t); }

/* The preset lab (app/web/emu/presets.js): the factory presets put on a track the way PRESETS puts one (preset_apply:
 * the project's undo and autosave see it), and the selected track's sound and knobs read back as the screen shows them. */
typedef struct {                       /* 212 bytes: web_lab()'s */
    uint8_t track, engine;             /* the track the keys play (T1..T8: 0..7), its EG_* */
    uint8_t rsv[2];
    char name[NAME_LEN + 4];           /* its sound's name, 0-ended */
    struct {
        char label[24], value[24];     /* a knob as the page shows it, 0-ended */
    } knob[4];
} lab_t;
_Static_assert(sizeof(lab_t) == 212, "lab_t: web/emu/presets.js reads 212 bytes");

static lab_t lab;

static void lab_copy(char *to, const char *from, size_t size)   /* from: maybe NULL, maybe not 0-ended within size */
{
    size_t i = 0;
    for (; from && i < size - 1 && from[i]; i++)
        to[i] = from[i];
    to[i] = 0;
}

__attribute__((used, visibility("default"))) uint32_t web_presets(void) { return (uint32_t)NPRESETS; }

/* the track the keys play and the page whose knobs the lab reads: T1..T8 (t) selected, on the Engine page (EDIT's) */
static void lab_select(int t)
{
    track_select(t);
    page_button(B_EDIT);
}

/* make T1..T8 (t) the selected track: 0, or -1 when there is no such track */
__attribute__((used, visibility("default"))) int32_t web_track(uint32_t t)
{
    if (t >= NTRK)
        return -1;
    lab_select((int)t);
    return 0;
}

/* factory preset k onto track t, which becomes the selected track: 0, or -1 when either does not exist */
__attribute__((used, visibility("default"))) int32_t web_preset(uint32_t t, uint32_t k)
{
    if (t >= NTRK || k >= (uint32_t)NPRESETS)
        return -1;
    lab_select((int)t);
    preset_apply((int)t, (int)k);
    ui.preset_i = (uint16_t)k;
    ui.pick_preset = (uint16_t)k;
    say("PRESET", PRESETS[k].name);
    return 0;
}

__attribute__((used, visibility("default"))) const uint8_t *web_lab(void)
{
    int t = inst_trk();
    knob_t k[4];
    lab.track = (uint8_t)t;
    lab.engine = proj.trk[t].par[TP_ENGINE];
    lab_copy(lab.name, proj.trk[t].name, NAME_LEN + 1);        /* (a name of NAME_LEN letters has no 0) */
    page_knobs(k);
    for (int i = 0; i < 4; i++) {
        lab_copy(lab.knob[i].label, k[i].name, sizeof lab.knob[i].label);
        lab_copy(lab.knob[i].value, k[i].val, sizeof lab.knob[i].value);
    }
    return (const uint8_t *)&lab;
}

__attribute__((used, visibility("default"))) uint32_t web_lab_size(void) { return (uint32_t)sizeof(lab_t); }
