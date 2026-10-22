import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('Missing #app mount point')

const app = mount(App, { target })

// Mark fonts as loaded without delaying first paint or interaction.
void document.fonts.ready.then(() => document.documentElement.classList.add('fonts-ready'))

export default app
