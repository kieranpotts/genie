/**
 * Message composition for the pickling-penguins extension.
 *
 * Each status message is built on-the-fly by pairing a random present
 * participle with a random noun, eg. "Pickling penguins...". With over 100
 * participles and nouns each, there are more than 10,000 possible
 * combinations, so repeats are rare. Both lists are sorted alphabetically.
 */

export const participles = [
  'alphabetizing', 'appeasing', 'bamboozling', 'befuddling', 'braising', 'bribing', 'buffering', 'caffeinating',
  'calculating', 'caramelizing', 'choreographing', 'compiling', 'consulting', 'converting', 'convincing', 'counting',
  'crocheting', 'debugging', 'deciding on', 'decrypting', 'defenestrating', 'defragmenting', 'discombobulating',
  'dividing', 'doomscrolling', 'downloading', 'duct-taping', 'emulsifying', 'exorcising', 'extrapolating', 'fermenting',
  'flambéing', 'flummoxing', 'galvanizing', 'gaslighting', 'generating', 'genuflecting before', 'gesticulating at',
  'gift-wrapping', 'harmonizing', 'herding', 'hoodwinking', 'hypnotizing', 'initializing', 'interpolating',
  'interrogating', 'juggling', 'kibitzing about', 'kneading', 'laminating', 'levitating', 'lubricating', 'manifesting',
  'marinating', 'masticating', 'mining', 'moonwalking past', 'negotiating with', 'optimizing', 'oscillating',
  'overclocking', 'percolating', 'photocopying', 'pickling', 'pirouetting around', 'polishing', 'procrastinating over',
  'reading', 'rebooting', 'recalibrating', 'refactoring', 'resurrecting', 'reticulating', 'reverse-engineering',
  'ruminating on', 'sacrificing', 'sandblasting', 'schlepping', 'shuffling', 'simmering', 'smuggling', 'soldering',
  'somersaulting over', 'stockpiling', 'summoning', 'syncopating', 'teaching', 'tessellating', 'tickling',
  'transcoding', 'unscrambling', 'untangling', 'untwisting', 'varnishing', 'watching', 'welding', 'whittling',
  'wrangling', 'wrestling', 'yeeting',
]

export const nouns = [
  'algorithms', 'alpacas', 'armadillos', 'axolotls', 'badgers', 'baguettes', 'bitcoins', 'brain cells', 'bratwurst',
  'capybaras', 'cats', 'churros', 'codswallop', 'conspiracies', 'contraptions', 'conundrums', 'croissants', 'dad jokes',
  'daemons', 'deadlines', 'demons', 'dependencies', 'doohickeys', 'doppelgängers', 'dumplings', 'easter eggs',
  'electrons', 'enigmas', 'entropy', 'existential dread', 'ferrets', 'fiddlesticks', 'flux capacitors', 'gizmos',
  'gnocchi', 'gnomes', 'gobbledygook', 'goblins', 'gubbins', 'hamsters', 'hedgehogs', 'hieroglyphs', 'hogwash',
  'hot takes', 'incantations', 'kerfuffles', 'kimchi', 'lemurs', 'llamas', 'loopholes', 'loose ends', 'malarkey',
  'marmots', 'meerkats', 'monads', 'mutexes', 'narwhals', 'okapis', 'otters', 'pangolins', 'paradoxes', 'penguins',
  'pierogi', 'pixels', 'platypuses', 'plot holes', 'pointers', 'poppycock', 'pretzels', 'prophecies', 'quokkas',
  'raccoons', 'ramen', 'red tape', 'rubber ducks', 'sauerkraut', 'schadenfreude', 'semaphores', 'shenanigans',
  'side quests', 'sigils', 'sloths', 'sockets', 'spaghetti', 'splines', 'stroopwafels', 'tacos', 'tapirs', 'the abyss',
  'the caches', 'the kraken', 'the matrix', 'the RAM', 'the runes', 'the singularity', 'the tea leaves', 'the vibes',
  'the void', 'the zeitgeist', 'thingamajigs', 'tumbleweeds', 'waffles', 'widgets', 'wizards', 'wombats', 'yaks',
]

/** Pick a uniformly random element from a non-empty list. */
export function randomItem<T> (list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

/** Compose a random status message from participle + noun. */
export function randomMessage (): string {
  const phrase = `${randomItem(participles)} ${randomItem(nouns)}`
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}...`
}
