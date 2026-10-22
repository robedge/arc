import { mount } from 'svelte'
import './app.css'
import DesignPreview from './lib/preview/DesignPreview.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('Missing #app mount point')

export default mount(DesignPreview, { target })
