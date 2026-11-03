import { createClient } from '../../kit/src/client'
import { mount } from './view'

mount(document.getElementById('app')!, createClient())
