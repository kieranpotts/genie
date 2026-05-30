/**
 * Replaces the default "Working..." status with humorous messages to make
 * waiting for the AI more entertaining. Each message is composed on-the-fly
 * by pairing a random present participle with a random noun, eg.
 * "picking gnomes...", giving a near-endless supply of nonsense.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/* The two lists below are paired at random to build each message. */

const participles = ['alphabetizing', 'appeasing', 'bamboozling', 'befuddling', 'braising', 'bribing', 'buffering', 'caffeinating', 'calculating', 'caramelizing', 'choreographing', 'compiling', 'consulting', 'converting', 'convincing', 'counting', 'crocheting', 'debugging', 'deciding on', 'decrypting', 'defenestrating', 'defragmenting', 'discombobulating', 'dividing', 'doomscrolling', 'downloading', 'duct-taping', 'emulsifying', 'exorcising', 'extrapolating', 'fermenting', 'flambéing', 'flummoxing', 'galvanizing', 'gaslighting', 'generating', 'genuflecting before', 'gesticulating at', 'gift-wrapping', 'harmonizing', 'herding', 'hoodwinking', 'hypnotizing', 'initializing', 'interpolating', 'interrogating', 'juggling', 'kibitzing about', 'kneading', 'laminating', 'levitating', 'lubricating', 'manifesting', 'marinating', 'masticating', 'mining', 'moonwalking past', 'negotiating with', 'optimizing', 'oscillating', 'overclocking', 'percolating', 'photocopying', 'pickling', 'pirouetting around', 'polishing', 'procrastinating over', 'reading', 'rebooting', 'recalibrating', 'refactoring', 'resurrecting', 'reticulating', 'reverse-engineering', 'ruminating on', 'sacrificing', 'sandblasting', 'schlepping', 'shuffling', 'simmering', 'smuggling', 'soldering', 'somersaulting over', 'stockpiling', 'summoning', 'syncopating', 'teaching', 'tessellating', 'tickling', 'transcoding', 'unscrambling', 'untangling', 'untwisting', 'varnishing', 'watching', 'welding', 'whittling', 'wrangling', 'wrestling', 'yeeting']

const nouns = ['algorithms', 'alpacas', 'armadillos', 'axolotls', 'badgers', 'baguettes', 'bitcoins', 'brain cells', 'bratwurst', 'capybaras', 'cats', 'churros', 'codswallop', 'conspiracies', 'contraptions', 'conundrums', 'croissants', 'dad jokes', 'daemons', 'deadlines', 'demons', 'dependencies', 'doohickeys', 'doppelgängers', 'dumplings', 'easter eggs', 'electrons', 'enigmas', 'entropy', 'existential dread', 'ferrets', 'fiddlesticks', 'flux capacitors', 'gizmos', 'gnocchi', 'gnomes', 'gobbledygook', 'goblins', 'gubbins', 'hamsters', 'hedgehogs', 'hieroglyphs', 'hogwash', 'hot takes', 'incantations', 'kerfuffles', 'kimchi', 'lemurs', 'llamas', 'loopholes', 'loose ends', 'malarkey', 'marmots', 'meerkats', 'monads', 'mutexes', 'narwhals', 'okapis', 'otters', 'pangolins', 'paradoxes', 'penguins', 'pierogi', 'pixels', 'platypuses', 'plot holes', 'pointers', 'poppycock', 'pretzels', 'prophecies', 'quokkas', 'raccoons', 'ramen', 'red tape', 'rubber ducks', 'sauerkraut', 'schadenfreude', 'semaphores', 'shenanigans', 'side quests', 'sigils', 'sloths', 'sockets', 'spaghetti', 'splines', 'stroopwafels', 'tacos', 'tapirs', 'the abyss', 'the caches', 'the kraken', 'the matrix', 'the RAM', 'the runes', 'the singularity', 'the tea leaves', 'the vibes', 'the void', 'the zeitgeist', 'thingamajigs', 'tumbleweeds', 'waffles', 'widgets', 'wizards', 'wombats', 'yaks']

/** Pick a uniformly random element from a non-empty list. */
function randomItem<T> (list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

/** Compose a random status message from participle + noun. */
function randomMessage (): string {
  const phrase = `${randomItem(participles)} ${randomItem(nouns)}`
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}...`
}

export default function (pi: ExtensionAPI) {
  let currentMessage: string | undefined

  /* When the agent starts processing, show a freshly composed message. */
  pi.on('agent_start', async (_event, ctx) => {
    currentMessage = randomMessage()
    ctx.ui.setWorkingMessage(currentMessage)
  })

  /* When the agent finishes, restore the default working indicator. */
  pi.on('agent_end', async (_event, ctx) => {
    ctx.ui.setWorkingMessage() /* Clear/restore default. */
    currentMessage = undefined
  })

  /* While running, occasionally swap in a new message to keep things lively. */
  pi.on('tool_execution_start', async (_event, ctx) => {
    /* Only reroll if a message is already showing, and only ~50% of the time. */
    if (currentMessage && Math.random() > 0.5) {
      currentMessage = randomMessage()
      ctx.ui.setWorkingMessage(currentMessage)
    }
  })
}
