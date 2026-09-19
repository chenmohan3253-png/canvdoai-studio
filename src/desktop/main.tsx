import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '../harness/App';
import './desktop.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<BrowserRouter><App /></BrowserRouter>);
