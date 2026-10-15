/**
 * Score a Sleeper stat line with an ESPN league's scoring rules.
 *
 * ESPN scoring is a list of {statId, points, pointsOverrides?} where the
 * override is keyed by the player's defaultPositionId. The tables below map
 * each ESPN statId onto Sleeper's stat names; anything unmapped (ESPN's
 * 40+/50+ yard TD bonuses, 100/300-yard game bonuses, blocked-kick TDs) is
 * skipped because Sleeper doesn't project it. Stat ids were verified against
 * ESPN's own appliedStats breakdown, see README.
 */
import type { EspnLeague } from "../espn/types.js";

export type Stats = Record<string, number | undefined>;
type Extract = (s: Stats) => number | undefined;

/** Sum of whichever keys are present; undefined when none are. */
const sum =
  (...keys: string[]): Extract =>
  (s) => {
    let total: number | undefined;
    for (const k of keys) if (s[k] !== undefined) total = (total ?? 0) + s[k]!;
    return total;
  };
/** First extractor that yields a value (for Sleeper's alternate spellings of the same stat). */
const either =
  (...alts: Extract[]): Extract =>
  (s) => {
    for (const a of alts) {
      const v = a(s);
      if (v !== undefined) return v;
    }
    return undefined;
  };
/** 1 if the expected value of `key` lands in [lo, hi], else 0. */
const bucket =
  (key: string, lo: number, hi: number): Extract =>
  (s) => {
    const v = s[key];
    return v === undefined ? undefined : v >= lo && v <= hi ? 1 : 0;
  };

const OFFENSE: Record<number, Extract> = {
  0: sum("pass_att"), 1: sum("pass_cmp"), 2: sum("pass_inc"), 3: sum("pass_yd"), 4: sum("pass_td"),
  15: sum("pass_td_40p"), 16: sum("pass_td_50p"), 17: sum("bonus_pass_yd_300"), 18: sum("bonus_pass_yd_400"),
  19: sum("pass_2pt"), 20: sum("pass_int"), 64: sum("pass_sack"),
  23: sum("rush_att"), 24: sum("rush_yd"), 25: sum("rush_td"), 26: sum("rush_2pt"),
  35: sum("rush_td_40p"), 36: sum("rush_td_50p"), 37: sum("bonus_rush_yd_100"), 38: sum("bonus_rush_yd_200"),
  42: sum("rec_yd"), 43: sum("rec_td"), 44: sum("rec_2pt"), 45: sum("rec_td_40p"), 46: sum("rec_td_50p"),
  53: sum("rec"), 56: sum("bonus_rec_yd_100"), 57: sum("bonus_rec_yd_200"), 58: sum("rec_tgt"),
  63: sum("def_fum_td"), 68: sum("fum"), 72: sum("fum_lost"),
  101: sum("def_kr_td"), 102: sum("pr_td"), 112: sum("def_kr_yd"), 113: sum("pr_yd"),
};

const KICKER: Record<number, Extract> = {
  74: either(sum("fgm_50p"), sum("fgm_50_59", "fgm_60p")),
  76: either(sum("fgmiss_50p"), sum("fgmiss_50_59", "fgmiss_60p")),
  77: sum("fgm_40_49"), 79: sum("fgmiss_40_49"),
  80: sum("fgm_0_19", "fgm_20_29", "fgm_30_39"), 82: sum("fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39"),
  83: sum("fgm"), 84: sum("fga"),
  85: either(sum("fgmiss"), sum("fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49", "fgmiss_50p")),
  86: sum("xpm"), 87: sum("xpa"), 88: sum("xpmiss"),
  198: either(sum("fgm_50_59"), sum("fgm_50p")), 201: sum("fgm_60p"),
};

const DEFENSE: Record<number, Extract> = {
  95: sum("int"), 96: sum("fum_rec"), 97: sum("blk_kick"), 98: sum("safe"), 99: sum("sack"),
  101: sum("def_kr_td"), 102: either(sum("def_pr_td"), sum("pr_td")), 103: sum("pass_int_td"), 104: sum("def_fum_td"),
  105: sum("def_td", "st_td"), 106: sum("ff"), 112: sum("def_kr_yd"), 113: either(sum("def_pr_yd"), sum("pr_yd")),
  120: sum("pts_allow"), 127: sum("yds_allow"),
  89: bucket("pts_allow", 0, 0), 90: bucket("pts_allow", 1, 6), 91: bucket("pts_allow", 7, 13),
  92: bucket("pts_allow", 14, 17), 121: bucket("pts_allow", 18, 21), 122: bucket("pts_allow", 22, 27),
  123: bucket("pts_allow", 28, 34), 124: bucket("pts_allow", 35, 45), 125: bucket("pts_allow", 46, Infinity),
  128: bucket("yds_allow", -Infinity, 99), 129: bucket("yds_allow", 100, 199), 130: bucket("yds_allow", 200, 299),
  131: bucket("yds_allow", 300, 349), 132: bucket("yds_allow", 350, 399), 133: bucket("yds_allow", 400, 449),
  134: bucket("yds_allow", 450, 499), 135: bucket("yds_allow", 500, 549), 136: bucket("yds_allow", 550, Infinity),
};

/** Sleeper position -> ESPN defaultPositionId, for looking up per-position point overrides. */
const ESPN_POS_ID: Record<string, number> = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };

/** Points for a Sleeper stat line at a Sleeper position ("QB", "DEF", ...). */
export type Scorer = (stats: Stats, position: string) => number;

/** Build a scorer from the league's ESPN scoring rules, or null if the settings don't include them. */
export function leagueScorer(league: EspnLeague): Scorer | null {
  const items = league.settings.scoringSettings?.scoringItems;
  if (!items?.length) return null;
  return (stats, position) => {
    const table = position === "DEF" ? DEFENSE : position === "K" ? KICKER : OFFENSE;
    const posId = ESPN_POS_ID[position];
    let total = 0;
    for (const item of items) {
      const override = posId === undefined ? undefined : item.pointsOverrides?.[posId];
      const pts = override ?? item.points;
      if (!pts) continue;
      const v = table[item.statId]?.(stats);
      if (v) total += pts * v;
    }
    return total;
  };
}

/**
 * ESPN's stock scoring (the defaults a new league gets), with receptions at
 * 1 / 0.5 / 0 for the three presets. Used to score historical seasons when a
 * league's own rules aren't available.
 */
export function presetScorer(receptions: number): Scorer {
  const items: EspnLeague["settings"]["scoringSettings"] = {
    scoringItems: [
      { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 19, points: 2 }, { statId: 20, points: -2 },
      { statId: 24, points: 0.1 }, { statId: 25, points: 6 }, { statId: 26, points: 2 },
      { statId: 42, points: 0.1 }, { statId: 43, points: 6 }, { statId: 44, points: 2 }, { statId: 53, points: receptions },
      { statId: 72, points: -2 },
      { statId: 80, points: 3 }, { statId: 77, points: 4 }, { statId: 74, points: 5 }, { statId: 85, points: -1 }, { statId: 86, points: 1 },
      { statId: 99, points: 1 }, { statId: 95, points: 2 }, { statId: 96, points: 2 }, { statId: 97, points: 2 }, { statId: 98, points: 2 },
      { statId: 105, points: 6 },
      { statId: 89, points: 5 }, { statId: 90, points: 4 }, { statId: 91, points: 3 }, { statId: 92, points: 1 },
      { statId: 121, points: 0 }, { statId: 122, points: -1 }, { statId: 123, points: -3 }, { statId: 124, points: -5 }, { statId: 125, points: -5 },
    ],
  };
  return leagueScorer({ settings: { scoringSettings: items } } as EspnLeague)!;
}
