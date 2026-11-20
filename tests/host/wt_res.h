/* SPDX-License-Identifier: MPL-2.0 */
/* The wavetable engine's tables for a host harness: the WTB1 section the FM-1 reads from its resource region, as
 * tools/gen_wavetables.py writes it to build/gen/wavetables.bin. wt_host_init() before the first jacquard voice;
 * it exits when the file is missing or short, so a harness never runs the engine silent by accident. */
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "synth.h"

static uint8_t wt_host_blob[WT_NTABLE * WT_NFRAME * WT_N];
static uint32_t wt_host_len;

static const uint8_t *wt_host_get(uint32_t *len)
{
    *len = wt_host_len;
    return wt_host_len ? wt_host_blob : 0;
}

static void wt_host_init(void)
{
    FILE *f = fopen("build/gen/wavetables.bin", "rb");
    if (!f) {
        fprintf(stderr, "wt_res: build/gen/wavetables.bin is missing (tools/gen_wavetables.py)\n");
        exit(2);
    }
    wt_host_len = (uint32_t)fread(wt_host_blob, 1, sizeof wt_host_blob, f);
    fclose(f);
    if (wt_host_len != sizeof wt_host_blob) {
        fprintf(stderr, "wt_res: build/gen/wavetables.bin holds %u bytes, not %u\n", wt_host_len,
                (unsigned)sizeof wt_host_blob);
        exit(2);
    }
    wt_res_get = wt_host_get;
}
