import { BINARY_TYPE_ENUM, RECORD_TYPE_ENUM, PRIMITIVE_TYPE_ENUM } from './enums'

export default class Reader {
  debug: Boolean = false;
  stream: any;

  header: any = [];
  classes: any = [];
  libraries: any = [];
  objects: any = [];

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
      try {
        const { recordType, data } = this.readRecord();
     
        switch (recordType) {
          case RECORD_TYPE_ENUM.SerializedStreamHeader:
            this.header = data;
            break;
          case RECORD_TYPE_ENUM.ClassWithId:
            this.classes.push(data);
            break;
          case RECORD_TYPE_ENUM.ClassWithMembersAndTypes:
            this.classes.push(data);
            break;
          case RECORD_TYPE_ENUM.BinaryObjectString:
            this.objects.push(data);
            break;
          case RECORD_TYPE_ENUM.MemberReference:
            this.objects.push(data);
            break;
          case RECORD_TYPE_ENUM.BinaryLibrary:
            this.libraries.push(data);
            break;
          case RECORD_TYPE_ENUM.MessageEnd:
            this.stream = undefined;
            return { header: this.header, classes: this.classes, libraries: this.libraries, objects: this.objects};
        }
      } catch(e) {

        throw e;
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

    const hex = [];
    charCodes.forEach(code => {
      hex.push(pad(code.toString(16)));
    })

    // console.log(hex.join(''));

    return output;
  }

  readRecord() {
    const recordType = this.readRecordType();

    if(this.debug) {
      console.log(`Record Type: ${recordType}`)
    }

    switch (recordType) {
      case RECORD_TYPE_ENUM.SerializedStreamHeader:
        return { recordType, data: this.readSerializationHeaderRecord() };
      case RECORD_TYPE_ENUM.ClassWithId:
        return { recordType, data: this.readClassWithId() };
      case RECORD_TYPE_ENUM.ClassWithMembersAndTypes:
        return { recordType, data: this.readClassWithMembersAndTypes() };
      case RECORD_TYPE_ENUM.BinaryObjectString:
        return { recordType, data: this.readBinaryObjectString() };
      case RECORD_TYPE_ENUM.MemberReference:
        return { recordType, data: this.readMemberReference() };
      case RECORD_TYPE_ENUM.BinaryLibrary:
        return { recordType, data: this.readBinaryLibrary() };
      case RECORD_TYPE_ENUM.MessageEnd:
          return { recordType };
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
    // 2.1.1 [MS-DTYP]
    return Boolean(this.read(1));
  }

  readByte() {
    // 2.1.1 [MS-DTYP]
    return this.read(1);
  }

  readInt16() {
    // 2.1.1 [MS-DTYP]
    var buffer = new ArrayBuffer(2);
    (new Int16Array(buffer))[0] = this.read(2);
    return new Int16Array(buffer)[0];
  }

  readInt32() {
    console.log('%%%%%%%%%%%%%%%%%%%')

    // 2.1.1 [MS-DTYP]
    var buffer = new ArrayBuffer(4);
    (new Int32Array(buffer))[0] = this.read(4);
    return new Int32Array(buffer)[0];
  }

  readInt64() {
    // 2.1.1 [MS-DTYP]
    // TODO: Implement me!
    this.read(8)

    // var buffer = new ArrayBuffer(8);
    // (new Uint32Array(buffer))[0] = this.read(4);
    // (new Uint32Array(buffer))[1] = this.read(4);
    // return new BigInt64Array(buffer)[0];
  }

  readUInt16() {
    // 2.1.1 [MS-DTYP]
    var buffer = new ArrayBuffer(8);
    (new Uint16Array(buffer))[0] = this.read(2);
    return new Uint16Array(buffer)[0];
  }

  readUInt32() {
    // 2.1.1 [MS-DTYP]
    var buffer = new ArrayBuffer(8);
    (new Uint32Array(buffer))[0] = this.read(4);
    return new Uint32Array(buffer)[0];
  }

  readUInt64() {
    // 2.1.1 [MS-DTYP]
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

    if (this.debug) {
      console.log(`ClassWithMembersAndTypes - ClassName: ${classInfo.name}, LibraryId: ${libraryId}`)
    }
    
    const data = this._readClassMembers(classInfo, memberTypeInfo);

    return { classInfo, memberTypeInfo, libraryId, data }
  }

  readClassWithId() {
    // TODO: Lookup the metaDataId, and then use that for reading data
    // 2.3.2.5
    const objectId = this.readInt32();
    const metaDataId = this.readInt32();

    // This doesn't work ATM
    const baseClass = this.classes.find(x => x.classInfo.id === metaDataId);

    const classInfo = baseClass.classInfo;
    classInfo.id = objectId;

    const data = this._readClassMembers(baseClass.classInfo, baseClass.memberTypeInfo);

    return { classInfo, memberTypeInfo: baseClass.memberTypeInfo, libraryId: baseClass.libraryId, data }
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


  _readClassMembers(classInfo, memberTypeInfo) {
    const data = {};

    const members = classInfo.memberNames.map((name, index) => [name].concat(memberTypeInfo[index]));

    members.forEach(member =>{
      console.log('****')
      const memberName = member[0];
      const memberType = member[1];

      if(this.debug) {
        console.log(`${classInfo.name} Member: ${memberName}, type: ${memberType}, additionalInfo:`);
        console.log(member[2])
      }

      switch(memberType) {
        case BINARY_TYPE_ENUM.Primitive:
          switch(member[2]) {
            case PRIMITIVE_TYPE_ENUM.Boolean:
              data[memberName] = this.readBoolean()
              break;
            case PRIMITIVE_TYPE_ENUM.Double:
              data[memberName] = this.readDouble()
              break;
            case PRIMITIVE_TYPE_ENUM.Int32:
              data[memberName] = this.readInt32()
              break;
            case PRIMITIVE_TYPE_ENUM.Int64:
              data[memberName] = this.readInt64();
              break;
            case PRIMITIVE_TYPE_ENUM.Single:
              data[memberName] = this.readSingle()
              break;
            case PRIMITIVE_TYPE_ENUM.UInt64:
              data[memberName] = this.readUInt64();
              break;
          }
          
          break;
        default:
          data[memberName] = this.readRecord().data;
          break;
      }
      console.log(data[memberName])
    })

    return data;
  }
}

function pad(s) {
  while (s.length < 2) {s = "0" + s;}
  return s;
}