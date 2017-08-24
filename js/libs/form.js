Fliplet.Widget.instance('form-builder', function(data) {
  var saveDelay = 1000; // save progress after 1s from last input
  var selector = '[data-form-builder-id="' + data.id + '"]';
  var progressKey = 'form-builder-progress-' + (data.uuid || data.id);

  var entryId = data.dataSourceId && Fliplet.Navigate.query.dataSourceEntryId;
  var entry;

  if (entryId) {
    entryId = parseInt(entryId, 10) || undefined;
  }

  function getProgress() {
    var progress = localStorage.getItem(progressKey);

    if (!progress) {
      return;
    }

    return JSON.parse(progress);
  }

  function debounce(func, wait, immediate) {
    var timeout;
    return function() {
      var context = this,
        args = arguments;
      var later = function() {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
      var callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(context, args);
    };
  }

  function getFields() {
    var fields = JSON.parse(JSON.stringify(data.fields || []));
    var progress = getProgress();

    if (fields.length && (data.saveProgress && typeof progress === 'object') || entry) {
      fields.forEach(function(field) {
        if (entry && typeof entry.data[field.name] !== 'undefined' && field.populateOnUpdate !== false) {
          return field.value = entry.data[field.name];
        }

        if (progress) {
          var savedValue = progress[field.name];

          if (typeof savedValue !== 'undefined') {
            field.value = savedValue;
          }
        }
      });
    }

    return fields;
  }

  function isFile(value) {
    return value && typeof value.item === 'function';
  }

  new Vue({
    el: $(selector)[0],
    data: function() {
      return {
        isSent: false,
        isSending: false,
        isSendingMessage: 'Saving data...',
        isLoading: !!entryId,
        isLoadingMessage: 'Retrieving data...',
        isConfigured: !!data.templateId,
        fields: getFields(),
        error: null,
        errors: {},
        isOffline: false,
        isOfflineMessage: '',
        isEditMode: data.dataStore && data.dataStore.indexOf('editDataSource') > -1,
        blockScreen: false
      };
    },
    computed: {
      hasRequiredFields: function() {
        return this.fields.some(function(el) {
          return !!el.required;
        });
      }
    },
    methods: {
      start: function() {
        this.isSent = false;
      },
      reset: function() {
        this.fields.forEach(function(field, index) {
          field.value = data.fields[index].value;
        });

        Fliplet.FormBuilder.emit('reset');
      },
      onError: function (fieldName, error) {
        if (!error) {
          if (this.errors[fieldName]) {
            delete this.errors[fieldName];
          }

          return;
        }

        this.errors[fieldName] = error;
      },
      onInput: function(fieldName, value) {
        this.fields.some(function(field) {
          if (field.name === fieldName) {
            field.value = value;
            return true;
          }
        });

        if (data.saveProgress) {
          this.saveProgress();
        }
      },
      onSubmit: function() {
        var $vm = this;
        var formData = {};

        this.isSending = true;

        function appendField(name, value) {
          if (Array.isArray(formData[name])) {
            formData[name].push(value);
          } else if (typeof formData[name] !== 'undefined') {
            formData[name] = [formData[name], value];
          } else {
            formData[name] = value;
          }
        }

        var errorFields = Object.keys(this.errors);
        var fieldErrors = [];
        if (errorFields.length) {
          errorFields.forEach(function (fieldName) {
            fieldErrors.push(errorFields[fieldName]);
          });

          $vm.error = fieldErrors.join('. ');
          $vm.isSending = false;
          return;
        }

        this.fields.forEach(function(field) {
          var value = field.value;
          var type = field.type;

          if (field._submit === false) {
            return;
          }

          if (field.submitWhenFalsy === false && !value) {
            return;
          }

          if (isFile(value)) {
            // File input
            for (var i = 0; i < value.length; i++) {
              appendField(field.name, value.item(i));
            }
          } else {
            // Remove spaces and dashes from value
            if (type === 'number' || type === 'tel') {
              value = value.replace(/-|\s/g, '');
            }
            // Other inputs
            appendField(field.name, value);
          }
        });

        Fliplet.Hooks.run('beforeFormSubmit', formData).then(function() {
          if (data.dataSourceId) {
            return Fliplet.DataSources.connect(data.dataSourceId);
          }

          return;
        }).then(function(connection) {
          // Append schema as private variable
          formData._flSchema = {};
          $vm.fields.forEach(function(field) {
            if (field.mediaFolderId) {
              formData._flSchema[field.name] = {
                mediaFolderId: field.mediaFolderId
              };
            }
          });

          if (entry && data.dataSourceId) {
            return connection.update(entryId, formData, {
              offline: data.offline
            });
          }

          if (data.onSubmit && data.onSubmit.indexOf('dataSource') > -1 && data.dataSourceId) {
            return connection.insert(formData, {
              offline: data.offline
            });
          }

          return;
        }).then(function() {
          if (data.saveProgress) {
            localStorage.removeItem(progressKey);
          }

          if (data.emailTemplate && data.onSubmit && data.onSubmit.indexOf('templatedEmail') > -1) {
            Fliplet.Communicate.sendEmail(data.emailTemplate, formData);
          }

          if (data.generateEmailTemplate && data.onSubmit && data.onSubmit.indexOf('generateEmail') > -1) {
            Fliplet.Communicate.composeEmail(data.generateEmailTemplate, formData);
          }

          if (data.linkAction && data.redirect) {
            return Fliplet.Navigate.to(data.linkAction);
          }

          $vm.isSent = true;
          $vm.isSending = false;
          $vm.reset();

          $vm.loadEntryForUpdate();
        }, function(err) {
          console.error(err);
          $vm.error = err.message || err.description || err;
          $vm.isSending = false;
        });

        // We might use this code to save the form data locally when going away from the page
        // $(window).unload(function onWindowUnload() {
        //   localStorage.setItem('fl-form-data-' + data.id, this.fields.map(function (field) {
        //     return { name: field.name, value: field.value };
        //   }));
        // });
      },
      loadEntryForUpdate() {
        var $vm = this;

        if (data.autobindProfileEditing) {
          return Fliplet.Session.get().then(function (session) {
            if (session.entries && session.entries.dataSource) {
              entryId = session.entries.dataSource.id;
              entry = session.entries.dataSource;
            }

            $vm.fields = getFields();
            $vm.isLoading = false;
          });
        }

        if (entryId) {
          return Fliplet.DataSources.connect(data.dataSourceId).then(function (ds) {
            return ds.findById(entryId);
          }).then(function (record) {
            if (!record) {
              $vm.error = 'This entry has not been found';
            }

            entry = record;

            $vm.fields = getFields();
            $vm.isLoading = false;
          }).catch(function (err) {
            $vm.error = err.message || err.description || err;
          });
        }
      }
    },
    mounted: function() {
      var $vm = this;

      this.saveProgress = debounce(function() {
        var progress = {};

        $vm.fields.forEach(function(field) {
          if (field.saveProgress !== false) {
            progress[field.name] = field.value;
          }
        });

        localStorage.setItem(progressKey, JSON.stringify(progress));
      }, saveDelay);

      $(selector).removeClass('is-loading');

      Fliplet.Hooks.on('beforeFormSubmit', function(data) {
        console.log('[Hook] beforeFormSubmit', data);
      });

      if (!data.offline) {
        Fliplet.Navigator.onOnline(function() {
          $vm.isOffline = false;
          $vm.blockScreen = false;
        });

        Fliplet.Navigator.onOffline(function() {
          $vm.isOffline = true;
          $vm.isOfflineMessage = data.dataStore && data.dataStore.indexOf('editDataSource') > -1 ?
            'The data can only be updated when connected to the internet.' :
            'This form can only be submitted when connected to the internet.';

          if ($vm.isEditMode && $vm.isLoading && $vm.isOffline) {
            $vm.blockScreen = true;
          }
        });
      }

      this.loadEntryForUpdate();
    }
  });
});
