import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    // Optional: send to logging
    console.error('ErrorBoundary caught:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{maxWidth: 900, margin: '40px auto', fontFamily: 'system-ui'}}>
          <h2>Something went wrong in the app.</h2>
          <pre style={{whiteSpace:'pre-wrap', background:'#fff3f3', padding:12, border:'1px solid #f5c2c7', borderRadius:8}}>
{String(this.state.error)}
{this.state.info?.componentStack ? '\n' + this.state.info.componentStack : ''}
          </pre>
          <p style={{color:'#666'}}>If you paste the text above to me, I can fix it quickly.</p>
        </div>
      );
    }
    return this.props.children;
  }
}