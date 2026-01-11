const bannedWords = [
  'nigger',
  'sex',
  'ejaculation',
  'penis',
  'vagina',
  'scrotum',
  'testicles',
]

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
}

function containsProfanity(text) {
  if (!text) return false
  
  const normalized = normalize(text)
  
  for (const word of bannedWords) {
    const normalizedWord = normalize(word)
    
    if (normalized.includes(normalizedWord)) {
      return true
    }
    
    const scattered = normalizedWord.split('').join('.*')
    const regex = new RegExp(scattered, 'i')
    if (regex.test(text)) {
      return true
    }
    
    const repeated = normalizedWord.split('').map(c => `${c}+`).join('')
    const repeatedRegex = new RegExp(repeated, 'i')
    if (repeatedRegex.test(normalized)) {
      return true
    }
  }
  
  return false
}

export { containsProfanity }
