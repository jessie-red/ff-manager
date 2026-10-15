/** ESPN lineupSlotId -> label. Bench/IR are not scoring slots. */
export const SLOT_NAMES: Record<number, string> = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 22: "?", 23: "FLEX",
  24: "ED", 25: "ER",
};

/** Positions that can fill each scoring slot; flex-type slots share their starters between positions. */
export const SLOT_POSITIONS: Record<number, string[]> = {
  0: ["QB"], 2: ["RB"], 4: ["WR"], 6: ["TE"], 16: ["D/ST"], 17: ["K"],
  3: ["RB", "WR"], 5: ["WR", "TE"], 23: ["RB", "WR", "TE"], 7: ["QB", "RB", "WR", "TE"],
};

export const BENCH_SLOT = 20;
export const IR_SLOT = 21;

/** Order in which slots are filled: most restrictive first, flex-type slots last. */
export const SLOT_FILL_ORDER = [0, 1, 2, 4, 6, 16, 17, 18, 19, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 3, 5, 23, 7];

/** ESPN defaultPositionId -> label. */
export const POSITION_NAMES: Record<number, string> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST",
};

/** Position label -> the dedicated lineup slot ESPN ranks that position within. */
export const POSITION_SLOT: Record<string, number> = { QB: 0, RB: 2, WR: 4, TE: 6, K: 17, "D/ST": 16 };

export const PRO_TEAMS: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};
