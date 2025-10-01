import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

if (typeof window !== 'undefined') {
  if (window.opener && window.name === 'plex-oauth') {
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        window.location.replace('about:blank');
      }
    }, 250);
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
