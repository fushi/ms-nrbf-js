const abab = require('abab');
const fs = require('fs');
const { Readable } = require('stream')

import { BINARY_TYPE_ENUM, RECORD_TYPE_ENUM, PRIMITIVE_TYPE_ENUM } from './enums'

class Reader {
  debug: Boolean = false;
  stream: any;

  convertToHex(stream) {
    this.stream = stream;

    this.stream.setEncoding('utf8');

    const output = [];

    while(stream.readable) {
      const readOutput = this.read(1);

      if(readOutput !== undefined) {
        output.push(pad(readOutput.toString(16)));
      }
    }

    return output.join('');
  }

  deserialize(stream) {
    this.stream = stream;

    this.stream.setEncoding('utf8');

    const result: any = { libraries: [], objects: [] };

    while(true) {
      const recordType = reader.readRecordType();

      if(this.debug) {
        console.log(`Record Type: ${recordType}`)
      }
  
      switch (recordType) {
        case RECORD_TYPE_ENUM.SerializedStreamHeader:
          result.header = this.readSerializationHeaderRecord();
          break;
        case RECORD_TYPE_ENUM.ClassWithId:
          result.objects.push(this.readClassWithId());
          break;
        case RECORD_TYPE_ENUM.ClassWithMembersAndTypes:
          result.objects.push(this.readClassWithMembersAndTypes());
          break;
        case RECORD_TYPE_ENUM.BinaryObjectString:
          result.objects.push(this.readBinaryObjectString());
          break;
        case RECORD_TYPE_ENUM.MemberReference:
          result.objects.push(this.readMemberReference());
          break;
        case RECORD_TYPE_ENUM.BinaryLibrary:
          result.libraries.push(this.readBinaryLibrary());
          break;
        case RECORD_TYPE_ENUM.MessageEnd:
          this.stream = undefined;
          return result;
        default:
          const hex = [];
          for(let i = 0; i < 20; i++) {
            hex.push(pad(this.read(1).toString(16)));
          }
          
          console.log(hex.join(''));
          throw(`No clue how to parse type ${recordType}`)
      }
    }
  }

  read(numBytes) {
    let output = 0;

    const binary = this.stream.read(numBytes);

    if(!binary) {
      this.stream.readable = false;
      return undefined;
    }

    const binaryArray = binary.split('');

    const charCodes = binaryArray.map(char => char.charCodeAt(0));

    charCodes.forEach(code => {
      output << 8;
      output += code;
    })

    return output;
  }

  readRecord() {
    const recordType = reader.readRecordType();

    if(this.debug) {
      console.log(`Record Type: ${recordType}`)
    }

    switch (recordType) {
      case RECORD_TYPE_ENUM.SerializedStreamHeader:
        return this.readSerializationHeaderRecord();
      case RECORD_TYPE_ENUM.ClassWithId:
        return this.readClassWithId();
      case RECORD_TYPE_ENUM.ClassWithMembersAndTypes:
        return this.readClassWithMembersAndTypes();
      case RECORD_TYPE_ENUM.BinaryObjectString:
        return this.readBinaryObjectString();
      case RECORD_TYPE_ENUM.MemberReference:
        return this.readMemberReference();
      case RECORD_TYPE_ENUM.BinaryLibrary:
        return this.readBinaryLibrary();
      default:
        const hex = [];
        for(let i = 0; i < 20; i++) {
          hex.push(pad(this.read(1).toString(16)));
        }
        
        console.log(hex.join(''));
        throw(`No clue how to parse type ${recordType}`)
    }
  }

  // Common Data Types
  readBoolean() {
    return Boolean(this.read(1));
  }

  readByte() {
    return this.read(1);
  }

  readInt16() {
    var buffer = new ArrayBuffer(8);
    (new Int16Array(buffer))[0] = this.read(2);
    return new Int16Array(buffer)[0];
  }

  readInt32() {
    var buffer = new ArrayBuffer(8);
    (new Int32Array(buffer))[0] = this.read(4);
    return new Int32Array(buffer)[0];
  }

  readInt64() {
    // TODO: Implement me!
    this.read(8)

    // var buffer = new ArrayBuffer(8);
    // (new Uint32Array(buffer))[0] = this.read(4);
    // (new Uint32Array(buffer))[1] = this.read(4);
    // return new BigInt64Array(buffer)[0];
  }

  readUInt16() {
    var buffer = new ArrayBuffer(8);
    (new Uint16Array(buffer))[0] = this.read(2);
    return new Uint16Array(buffer)[0];
  }

  readUInt32() {
    var buffer = new ArrayBuffer(8);
    (new Uint32Array(buffer))[0] = this.read(4);
    return new Uint32Array(buffer)[0];
  }

  readUInt64() {
    // TODO: Implement me!
    this.read(8)

    // var buffer = new ArrayBuffer(8);
    // (new Uint32Array(buffer))[0] = this.read(4);
    // (new Uint32Array(buffer))[1] = this.read(4);
    // return new BigInt64Array(buffer)[0];
  }

  readDouble() {
    // 2.1.1.2
    var buffer = new ArrayBuffer(8);
    (new Uint32Array(buffer))[0] = this.read(4);
    (new Uint32Array(buffer))[1] = this.read(4);
    return new Float64Array(buffer)[0];
  }

  readSingle() {
    // 2.1.1.3
    var buffer = new ArrayBuffer(8);
    (new Uint32Array(buffer))[0] = this.read(4);
    return new Float32Array(buffer)[0];
  }

  readLengthPrefixedString() {
    // 2.1.1.6
    let i = 0;
    let highBit = 1;
    let length = 0;
    let output = [];

    while(highBit) {
      const data = this.read(1);

      highBit = data & 128;

      length += (data & 127) << (7 * i);

      i++;
    }

    for(i = 0; i < length; i ++){
      const readOutput = this.read(1);

      output.push(String.fromCharCode(readOutput));
    }

    return output.join('');
  }

  readClassTypeInfo() {
    // 2.1.1.8
    const typeName = this.readLengthPrefixedString();
    const libraryId = this.readInt32();

    return { typeName, libraryId };
  }

  // Enumerations
  readRecordType() {
    // 2.1.2.1
    return this.read(1) as typeof RECORD_TYPE_ENUM[keyof typeof RECORD_TYPE_ENUM];
  }

  readBinaryType() {
    // 2.1.2.2
    return this.read(1) as typeof BINARY_TYPE_ENUM[keyof typeof BINARY_TYPE_ENUM];
  }

  readPrimitiveType() {
    // 2.1.2.3
    return this.read(1) as typeof PRIMITIVE_TYPE_ENUM[keyof typeof PRIMITIVE_TYPE_ENUM];
  }

  // Class Records
  readClassInfo() {
    // 2.3.1.1
    const id = this.readInt32();
    const name = this.readLengthPrefixedString();
    const memberCount = this.readInt32();
    
    const memberNames = [];

    for(let i = 0; i < memberCount; i++ ) {
      memberNames.push(this.readLengthPrefixedString())
    }

    return { id, name, memberCount, memberNames }
  }

  readMemberTypeInfo(numberOfTypeInfos: number) {
    // 2.3.1.2
    const binaryTypes = [];
    
    for(let i = 0; i < numberOfTypeInfos; i++) {
      binaryTypes.push(this.readBinaryType());
    }

    return binaryTypes.map(binaryType => {
      switch(binaryType) {
        case BINARY_TYPE_ENUM.Primitive:
        case BINARY_TYPE_ENUM.PrimitiveArray:
          return [binaryType, this.readPrimitiveType()]
        case BINARY_TYPE_ENUM.SystemClass:
          return [binaryType, this.readLengthPrefixedString()];
        case BINARY_TYPE_ENUM.Class:
          return [binaryType, this.readClassTypeInfo()];
        default:
          return [binaryType, null];
      }
    })
  }

  readClassWithMembersAndTypes() {
    // 2.3.2.1
    const classInfo = this.readClassInfo();
    const memberTypeInfo = this.readMemberTypeInfo(classInfo.memberCount);
    const libraryId = this.readInt32();

    const members = classInfo.memberNames.map((name, index) => [name].concat(memberTypeInfo[index]));

    console.log(`ClassWithMembersAndTypes - ClassName: ${classInfo.name}, LibraryId: ${libraryId}`)
    
    const data = {};

    members.forEach(member =>{
      console.log(`${classInfo.name} Member: ${member[0]}, type: ${member[1]}, additionalInfo:`);
      console.log(member[2])

      switch(member[1]) {
        case BINARY_TYPE_ENUM.Primitive:
          switch(member[2]) {
            case PRIMITIVE_TYPE_ENUM.Boolean:
              data[member[0]] = this.readBoolean()
              break;
            case PRIMITIVE_TYPE_ENUM.Double:
              data[member[0]] = this.readDouble()
              break;
            case PRIMITIVE_TYPE_ENUM.Int32:
              data[member[0]] = this.readInt32()
              break;
            case PRIMITIVE_TYPE_ENUM.Int64:
              data[member[0]] = this.readInt64();
              break;
            case PRIMITIVE_TYPE_ENUM.Single:
              data[member[0]] = this.readSingle()
              break;
            case PRIMITIVE_TYPE_ENUM.UInt64:
              data[member[0]] = this.readUInt64();
              break;

          }
          break;
        default:
          data[member[0]] = this.readRecord();
          break;
      }

      console.log(data[member[0]])
    })

    return { classInfo, memberTypeInfo, libraryId, data }
  }

  readClassWithId() {
    const objectId = this.readInt32();
    const metaData = this.readInt32();

    return { objectId, metaData }
  }

  // Member Reference Records
  readMemberReference() {
    // 2.5.3
    const idRef = this.readInt32();

    return { idRef };
  }

  readBinaryObjectString() {
    // 2.5.7
    const objectId = this.readInt32();
    const value = this.readLengthPrefixedString();

    if(this.debug) {
      console.log(`ObjectId: ${objectId}, Value: ${value}`)
    }

    return { objectId, value };
  }

  // Other Records
  readSerializationHeaderRecord() {
    // 2.6.1
    const rootId = this.readInt32();
    const headerId = this.readInt32();
    const majorVersion = this.readInt32();
    const minorVersion = this.readInt32();
    
    const header = {
      rootId,
      headerId,
      majorVersion,
      minorVersion
    };

    if(this.debug) {
      console.log(header);
    }

    return header;
  }

  readBinaryLibrary() {
    // 2.6.2
    const id = this.readInt32();
    const name = this.readLengthPrefixedString();
  
    if(this.debug) {
      console.log(`BinaryLibrary - id: ${id}, name: ${name}`)
    }

    return { id, name };
  }
}

const fileContents = fs.readFileSync('./ngusave.txt');

const decodedString = abab.atob(fileContents);

const reader = new Reader();

const output = reader.deserialize(Readable.from(decodedString, { objectMode: false }));

// console.log(output.libraries);
// console.log(output.objects);
// console.log(output.header);

const decodedSave = abab.atob(output.objects[0].data.playerData.value);

reader.debug = true;

const saveOutput = reader.deserialize(Readable.from(decodedSave, { objectMode: false }));
console.log('Header');
console.log(saveOutput.header);

console.log('Libraries');
console.log(saveOutput.libraries);

console.log('Objects');
console.log(saveOutput.objects);

// console.log(reader.convertToHex(Readable.from(decodedSave, { objectMode: false })));


function pad(s) {
  while (s.length < 2) {s = "0" + s;}
  return s;
}