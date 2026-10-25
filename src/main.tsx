import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceBoundary } from './WorkspaceBoundary';
import './style.css';
import './workflow.css';
import './guided-workspace.css';
import './dark-mode.css';

createRoot(document.getElementById('root')!).render(<StrictMode><WorkspaceBoundary><App /></WorkspaceBoundary></StrictMode>);
