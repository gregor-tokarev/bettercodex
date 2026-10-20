import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initApp } from './lib/store';
import './styles.css';

document.documentElement.classList.add(navigator.platform.toLowerCase().includes('mac') ? 'platform-mac' : 'platform-other');
createRoot(document.getElementById('root')!).render(<App />);
void initApp();
