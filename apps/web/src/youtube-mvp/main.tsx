import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import YouTubeMvp from './YouTubeMvp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><YouTubeMvp /></StrictMode>);
