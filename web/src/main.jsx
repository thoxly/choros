import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import AppShell from './app-shell/shell.jsx';
import './design/tokens.css';
import './components/components.css';
import './app-shell/app.css';
import './screens/rights/rights-admin.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AppShell />
  </BrowserRouter>
);
