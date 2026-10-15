/** Minimal typings for the slices of ESPN's v3 fantasy API we consume. */

export interface EspnStat {
  id: string;
  seasonId: number;
  scoringPeriodId: number;
  /** 0 = actual, 1 = projected */
  statSourceId: number;
  /** 0 = season total, 1 = single scoring period */
  statSplitTypeId: number;
  appliedTotal?: number;
  appliedAverage?: number;
}

/**
 * One analyst's (or the consensus) positional rank for a scoring period.
 * rankSourceId 0 is ESPN's consensus row, which carries `averageRank` and a
 * placeholder `rank` of 0; other sources are individual analysts.
 */
export interface EspnRanking {
  rank: number;
  averageRank?: number;
  rankSourceId: number;
  /** "PPR" | "STANDARD" | ...; the league's applies via scoringSettings.playerRankType. */
  rankType: string;
  /** Lineup slot the rank is within (2 = RB, 4 = WR, ...). */
  slotId: number;
  published: boolean;
}

export interface EspnPlayer {
  id: number;
  fullName: string;
  defaultPositionId: number;
  eligibleSlots: number[];
  proTeamId: number;
  injured?: boolean;
  injuryStatus?: string;
  stats?: EspnStat[];
  /** Positional ranks keyed by scoring period: "0" is rest-of-season, "N" is week N. */
  rankings?: Record<string, EspnRanking[]>;
  /** ESPN's pre-draft overall rank and auction value, by rank type (PPR, STANDARD, ...). */
  draftRanksByRankType?: Record<string, { rank: number; auctionValue?: number }>;
  /** League-wide ownership figures; `averageDraftPosition` is ESPN's ADP across its leagues. */
  ownership?: { averageDraftPosition?: number; percentOwned?: number; auctionValueAverage?: number };
}

/** A player pool row (view kona_player_info): the record plus who, if anyone, rosters them in this league. */
export interface EspnPoolEntry {
  id: number;
  /** Fantasy team id, 0 when unrostered. */
  onTeamId: number;
  /** "ONTEAM" | "FREEAGENT" | "WAIVERS" */
  status?: string;
  player: EspnPlayer;
}

export interface EspnRosterEntry {
  playerId: number;
  lineupSlotId: number;
  injuryStatus?: string;
  playerPoolEntry: { player: EspnPlayer; lineupLocked?: boolean };
}

export interface EspnTeam {
  id: number;
  abbrev: string;
  name: string;
  owners?: string[];
  logo?: string;
  currentProjectedRank?: number;
  playoffSeed?: number;
  record?: { overall?: { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number } };
  roster?: { entries: EspnRosterEntry[] };
}

export interface EspnMember {
  id: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
}

/** One side of a matchup. `totalPoints` is the actual score once the period has been played. */
export interface EspnMatchupSide {
  teamId: number;
  totalPoints: number;
  /** Live matchup total supplied by mMatchupScore, including games in progress. */
  totalPointsLive?: number;
}

/** A scheduled game. Bye weeks (odd team counts) come through with no `away`. */
export interface EspnMatchup {
  id: number;
  matchupPeriodId: number;
  home: EspnMatchupSide;
  away?: EspnMatchupSide;
  winner: "HOME" | "AWAY" | "TIE" | "UNDECIDED";
  /** Set on playoff/consolation games; absent during the regular season. */
  playoffTierType?: string;
}

/** One draft selection (view mDraftDetail). In auctions `bidAmount` is the winning bid. */
export interface EspnDraftPick {
  id: number;
  overallPickNumber: number;
  roundId: number;
  roundPickNumber: number;
  teamId: number;
  playerId: number;
  /** Roster slot the player was drafted into (20 = bench). */
  lineupSlotId: number;
  bidAmount: number;
  keeper: boolean;
  /** 0 when the manager made the pick themselves; nonzero when ESPN auto-drafted it. */
  autoDraftTypeId: number;
}

/** An NFL team as ESPN lists it, from the season-level proTeamSchedules view. */
export interface EspnProTeam {
  id: number;
  abbrev: string;
  byeWeek?: number;
  proGamesByScoringPeriod?: Record<string, { date: number; homeProTeamId: number; awayProTeamId: number; startTimeTBD?: boolean }[]>;
}

/** Read shape from mPendingTransactions; separate from write transaction bodies. */
export interface EspnPendingTransaction {
  id: string;
  type: string;
  teamId: number;
  isPending?: boolean;
  status?: string;
  items?: { playerId: number; type: string; fromTeamId: number; toTeamId: number }[];
  proposedDate?: number;
  expirationDate?: number;
  processDate?: number;
  acceptedDate?: number;
  /** TRADE_ACCEPT and other responses: the offer they act on. */
  relatedTransactionId?: string;
  bidAmount?: number;
  subOrder?: number;
  comment?: string;
}

export interface EspnLeague {
  id: number;
  seasonId: number;
  scoringPeriodId: number;
  status?: { currentMatchupPeriod?: number; finalScoringPeriod?: number; latestScoringPeriod?: number };
  members?: EspnMember[];
  teams: EspnTeam[];
  /** Omitted by ESPN when no requests are pending. */
  pendingTransactions?: EspnPendingTransaction[];
  /** Every matchup of the season (view mMatchup), regular season and playoffs alike. */
  schedule?: EspnMatchup[];
  /** The draft (view mDraftDetail); `picks` is empty until it has happened. */
  draftDetail?: { drafted: boolean; inProgress: boolean; completeDate?: number; picks?: EspnDraftPick[] };
  settings: {
    name: string;
    rosterSettings: { lineupSlotCounts: Record<string, number> };
    draftSettings?: {
      /** "SNAKE" | "AUCTION" | "OFFLINE" | ... */
      type?: string;
      /** Team ids in round-1 order. */
      pickOrder?: number[];
      auctionBudget?: number;
    };
    scoringSettings?: {
      /** Which rankType (PPR, STANDARD, ...) applies to this league's scoring. */
      playerRankType?: string;
      /** pointsOverrides is keyed by defaultPositionId and replaces `points` for that position. */
      scoringItems?: { statId: number; points: number; pointsOverrides?: Record<string, number> }[];
    };
    scheduleSettings?: {
      /** Regular-season length in matchup periods. */
      matchupPeriodCount?: number;
      playoffTeamCount?: number;
      playoffReseed?: boolean;
      playoffSeedingRule?: string;
      /** Omitted by ESPN football for its default higher-seed playoff tiebreaker. */
      playoffMatchupTieRule?: string;
      divisions?: { id: number }[];
      /** Scoring periods (NFL weeks) that make up each matchup period; usually one each. */
      matchupPeriods?: Record<string, number[]>;
    };
  };
}
