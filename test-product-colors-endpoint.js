const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/product-colors';
let testsPassed = 0;
let testsFailed = 0;

const logPass = (message) => {
    console.log(`PASS: ${message}`);
    testsPassed++;
};

const logFail = (message, reason) => {
    console.error(`FAIL: ${message} - ${reason}`);
    testsFailed++;
};

const validateColorObject = (color, styleNumber) => {
    let valid = true;
    if (!(color.COLOR_NAME && typeof color.COLOR_NAME === 'string' && color.COLOR_NAME.trim() !== '')) {
        logFail(`Style ${styleNumber} - Color object COLOR_NAME is not a non-empty string`, `Received: ${color.COLOR_NAME}`);
        valid = false;
    }
    if (!(color.CATALOG_COLOR && typeof color.CATALOG_COLOR === 'string' && color.CATALOG_COLOR.trim() !== '')) {
        logFail(`Style ${styleNumber} - Color object CATALOG_COLOR is not a non-empty string`, `Received: ${color.CATALOG_COLOR}`);
        valid = false;
    }
    const colorSwatch = color.COLOR_SQUARE_IMAGE || color.COLOR_SWATCH_IMAGE_URL;
    if (!(colorSwatch && typeof colorSwatch === 'string' && colorSwatch.trim() !== '')) {
        logFail(`Style ${styleNumber} - Color object COLOR_SQUARE_IMAGE or COLOR_SWATCH_IMAGE_URL is not a non-empty string`, `Received: ${colorSwatch}`);
        valid = false;
    }
    const hasMainImage = color.MAIN_IMAGE_URL && typeof color.MAIN_IMAGE_URL === 'string' && color.MAIN_IMAGE_URL.trim() !== '';
    const hasFrontModel = color.FRONT_MODEL && typeof color.FRONT_MODEL === 'string' && color.FRONT_MODEL.trim() !== '';
    const hasFrontFlat = color.FRONT_FLAT && typeof color.FRONT_FLAT === 'string' && color.FRONT_FLAT.trim() !== '';
    if (!(hasMainImage || hasFrontModel || hasFrontFlat)) {
        logFail(`Style ${styleNumber} - Color object does not have at least one of MAIN_IMAGE_URL, FRONT_MODEL, or FRONT_FLAT as a non-empty string`, 
                  `MAIN_IMAGE_URL: ${color.MAIN_IMAGE_URL}, FRONT_MODEL: ${color.FRONT_MODEL}, FRONT_FLAT: ${color.FRONT_FLAT}`);
        valid = false;
    }
    return valid;
};

const testStyle = async (styleNumber, expectColors, isEmptyColorArray = false) => {
    console.log(`\n--- Testing Style: ${styleNumber} ---`);
    try {
        const response = await axios.get(`${BASE_URL}?styleNumber=${styleNumber}`);
        const data = response.data;

        if (data.hasOwnProperty('productTitle')) {
            if (data.productTitle === null || typeof data.productTitle === 'string') {
                logPass(`Style ${styleNumber} - productTitle exists and is a string or null`);
            } else {
                logFail(`Style ${styleNumber} - productTitle is not a string or null`, `Type: ${typeof data.productTitle}, Value: ${data.productTitle}`);
            }
        } else {
            logPass(`Style ${styleNumber} - productTitle is optional and not present`);
        }

        if (data.hasOwnProperty('colors') && Array.isArray(data.colors)) {
            logPass(`Style ${styleNumber} - colors exists and is an array`);

            if (isEmptyColorArray) {
                if (data.colors.length === 0) {
                    logPass(`Style ${styleNumber} - colors array is empty as expected`);
                } else {
                    logFail(`Style ${styleNumber} - colors array was expected to be empty but was not`, `Length: ${data.colors.length}`);
                }
            } else if (expectColors) {
                if (data.colors.length > 0) {
                    logPass(`Style ${styleNumber} - colors array is not empty`);
                    let allColorsValid = true;
                    data.colors.forEach((color, index) => {
                        console.log(`  Validating color ${index + 1}: ${color.COLOR_NAME}`);
                        if (!validateColorObject(color, styleNumber)) {
                            allColorsValid = false;
                        }
                    });
                    if (allColorsValid) {
                        logPass(`Style ${styleNumber} - All color objects in the array are valid`);
                    } else {
                        logFail(`Style ${styleNumber} - Some color objects in the array are invalid`);
                    }
                } else {
                    logFail(`Style ${styleNumber} - colors array is empty, but was expected to have items`);
                }
            }
        } else {
            logFail(`Style ${styleNumber} - colors does not exist or is not an array`, `Received: ${JSON.stringify(data.colors)}`);
        }

    } catch (error) {
        logFail(`Style ${styleNumber} - Request failed or error during validation`, error.message);
        if (error.response) {
            console.error("Error response data:", error.response.data);
            console.error("Error response status:", error.response.status);
        }
    }
};

const runTests = async () => {
    await testStyle('PC61', true); // Expects colors
    await testStyle('J790', true, false); // Expects colors, not an empty array
    // Add more test cases if needed, e.g., a style that might return productTitle: null
    // await testStyle('NONEXISTENTSTYLE', false, true); // Example for a style that might not be found

    console.log("\n--- Test Summary ---");
    if (testsFailed === 0) {
        console.log(`All ${testsPassed} tests passed!`);
    } else {
        console.log(`${testsPassed} tests passed.`);
        console.error(`${testsFailed} tests failed.`);
    }
    console.log("--------------------");

    if (testsFailed > 0) {
        process.exit(1); // Indicate failure
    }
};

runTests();