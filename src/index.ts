const abab = require('abab');
const fs = require('fs');
const { Readable } = require('stream')

import Reader from './reader'

const fileContents = fs.readFileSync('./ngusave.txt');

const decodedString = abab.atob(fileContents);

const reader = new Reader();

const output = reader.deserialize(Readable.from(decodedString, { objectMode: false }));

console.log(output.libraries);
console.log(output.classes);
console.log(output.header);
console.log(output.objects);

const decodedSave = abab.atob(output.classes[0].data.playerData.value);

// console.log(reader.convertToHex(Readable.from(decodedSave, { objectMode: false })));

reader.debug = true;

const saveOutput = reader.deserialize(Readable.from(decodedSave, { objectMode: false }));
// console.log('Header');
// console.log(saveOutput.header);

// console.log('Libraries');
// console.log(saveOutput.libraries);

// console.log('Objects');
// console.log(saveOutput.objects);


