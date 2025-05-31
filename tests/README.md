# Tests Directory

This directory contains all testing files organized by purpose.

## Structure

- **`integration/`** - Full API endpoint tests that verify server functionality
- **`unit/`** - Component and utility tests for specific functionality  
- **`manual/`** - HTML pages for manual browser testing
- **`data/`** - JSON test data files and configurations

## Running Tests

```bash
# Run integration tests
node tests/integration/test-all-endpoints.js

# Run specific unit tests
node tests/unit/test-cart-items.js

# Open manual tests in browser
open tests/manual/api-test.html
```

## Adding New Tests

- Place API tests in `integration/`
- Place component tests in `unit/`
- Use descriptive file names
- Include test documentation in file comments