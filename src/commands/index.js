import * as rank from './rank.js';
import * as leaderboard from './leaderboard.js';
import * as giveXp from './give-xp.js';
import * as removeXp from './remove-xp.js';
import * as setLevelCmd from './set-level.js';
import * as resetXp from './reset-xp.js';
import * as syncRoles from './sync-roles.js';
import * as levelConfig from './level-config.js';
import * as trigger from './trigger.js';
import * as dupe from './dupe.js';
import * as aiFilter from './ai-filter.js';
import * as log from './log.js';
import * as rejoin from './rejoin.js';

export const commands = [rank, leaderboard, giveXp, removeXp, setLevelCmd, resetXp, syncRoles, levelConfig, trigger, dupe, aiFilter, log, rejoin];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
