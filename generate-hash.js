import bcrypt from 'bcrypt'
import { createInterface } from 'readline'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.question('Enter your admin password: ', async (password) => {
  const hash = await bcrypt.hash(password, 10)
  console.log('\nYour bcrypt hash:')
  console.log(hash)
  console.log('\nAdd this to your .env file as:')
  console.log(`ADMIN_PASS_HASH=${hash}`)
  rl.close()
})
